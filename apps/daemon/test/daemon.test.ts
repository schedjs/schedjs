import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createDaemon } from '../src/daemon.js';
import { createDockerRunner, createHttpRunner, createSqliteStorage, type PollResult, type RunOutcome, type Runner, type RunnerRunHooks } from '@schedjs/core';

const FIXTURE = fileURLToPath(new URL('./fixtures/tasks.json', import.meta.url));
const DOCKER_FIXTURE = fileURLToPath(new URL('./fixtures/tasks-docker.json', import.meta.url));
const UNKNOWN_FIXTURE = fileURLToPath(new URL('./fixtures/tasks-unknown.json', import.meta.url));
const ACCEPT_FIXTURE = fileURLToPath(new URL('./fixtures/tasks-accept.json', import.meta.url));
const SANDBOX_OK_FIXTURE = fileURLToPath(new URL('./fixtures/tasks-sandbox-ok.json', import.meta.url));
const SANDBOX_EVIL_FIXTURE = fileURLToPath(new URL('./fixtures/tasks-sandbox-evil.json', import.meta.url));
const SANDBOX_IGNORED_FIXTURE = fileURLToPath(new URL('./fixtures/tasks-sandbox-ignored.json', import.meta.url));

function makeRunner() {
  const calls: Array<{ taskName: string; runId: string; hooks: RunnerRunHooks | undefined }> = [];
  return {
    calls,
    runner: {
      async run(task: { name: string }, runId: string, _at: Date, hooks?: RunnerRunHooks): Promise<RunOutcome> {
        calls.push({ taskName: task.name, runId, hooks });
        return { status: 'succeeded' };
      },
    },
  };
}

const NOW = new Date('2026-08-16T12:00:00Z');

describe('createDaemon', () => {
  it('syncs tasks.json into storage, dispatches per-task runner, and starts the engine', async () => {
    const { runner, calls } = makeRunner();
    const daemon = createDaemon({ tasksPath: FIXTURE, dbPath: ':memory:', runners: { test: runner }, now: () => NOW });

    await daemon.start();

    const tasks = await daemon.storage.listTasks();
    // storage lists tasks ordered by name
    expect(tasks.map((t) => t.name)).toEqual(['daily', 'every-minute']);
    expect(tasks.map((t) => t.runner)).toEqual(['test', 'test']);

    // not due yet (nextRunAt is in the future) → runOnce does nothing
    await daemon.engine.runOnce();
    expect(calls).toHaveLength(0);

    // advance past the every-minute schedule → fires via the 'test' runner
    await daemon.engine.runOnce(new Date('2026-08-16T12:02:00Z'));
    expect(calls.map((c) => c.taskName)).toEqual(['every-minute']);
    // the dispatcher must forward the engine's onProgress hook to the runner
    expect(typeof calls[0]?.hooks?.onProgress).toBe('function');

    daemon.stop();
  });

  it('accepts an external storage (r6 D1): provided storage wins over internal sqlite, dbPath optional', async () => {
    const { runner } = makeRunner();
    const db = new DatabaseSync(':memory:');
    const storage = createSqliteStorage(db);
    const daemon = createDaemon({
      tasksPath: FIXTURE,
      storage,
      runners: { test: runner },
      now: () => NOW,
    });

    expect(daemon.storage).toBe(storage);
    await daemon.start();
    expect((await daemon.storage.listTasks()).map((t) => t.name)).toEqual(['daily', 'every-minute']);

    daemon.stop();
    db.close();
  });

  it('stop() shuts down the engine and closes the db', async () => {
    const { runner } = makeRunner();
    const daemon = createDaemon({ tasksPath: FIXTURE, dbPath: ':memory:', runners: { test: runner }, now: () => NOW });
    await daemon.start();
    expect(() => daemon.stop()).not.toThrow();
  });

  it('recovers orphaned in-flight runs on start (restart): run cancelled, lock released immediately', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-recovery-'));
    const dbPath = join(dir, 'sched.db');
    const seedDb = new DatabaseSync(dbPath);
    const seed = createSqliteStorage(seedDb);
    // simulate a previous process that died mid-run: task locked + run 'running'
    await seed.upsertTask({
      name: 'every-minute',
      runner: 'test',
      schedule: { kind: 'interval', ms: 60_000 },
      tz: 'UTC',
      config: {},
      label: null,
      description: null,
      nextRunAt: new Date('2026-08-16T11:50:00Z'),
      lastRunAt: null,
      lockedAt: new Date('2026-08-16T11:50:00Z'),
      failCount: 0,
      priority: 0,
      retry: null,
      retryCount: 0,
      lastRunId: null,
      paused: false,
      disabled: false,
    });
    await seed.createRun({
      id: 'orphan-1',
      taskName: 'every-minute',
      runner: 'test',
      startedAt: new Date('2026-08-16T11:50:00Z'),
      finishedAt: null,
      status: 'running',
      data: null,
      result: null,
      error: null,
      progress: null,
      log: null,
      artifacts: null,
      workerRef: null,
      attempt: 1,
      trigger: 'schedule',
      triggeredBy: null,
      scheduleId: null,
      temporary: false,
      retryOf: null,
    });
    seedDb.close();

    const { runner } = makeRunner();
    const daemon = createDaemon({ tasksPath: FIXTURE, dbPath, runners: { test: runner }, now: () => NOW });
    await daemon.start();

    const run = await daemon.storage.getRun('orphan-1');
    expect(run!.status).toBe('cancelled');
    expect(run!.finishedAt).not.toBeNull();
    expect((await daemon.storage.getTask('every-minute'))!.lockedAt).toBeNull(); // lock released, not waiting lockTtl
    expect((await daemon.storage.getTask('every-minute'))!.failCount).toBe(0);
    daemon.stop();
  });

  it('live-sync reconciles file changes via runSyncOnce; a broken file is ignored with a log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-livesync-'));
    const tasksPath = join(dir, 'tasks.json');
    writeFileSync(tasksPath, JSON.stringify({ tasks: [{ name: 'a', runner: 'test', config: {} }] }));
    const { runner } = makeRunner();
    const daemon = createDaemon({ tasksPath, dbPath: ':memory:', runners: { test: runner }, now: () => NOW, syncIntervalMs: 0 });
    await daemon.start();
    expect(await daemon.storage.getTask('a')).not.toBeNull();

    // file edited: 'a' removed (→ disabled), 'b' added
    writeFileSync(tasksPath, JSON.stringify({ tasks: [{ name: 'b', runner: 'test', config: {} }] }));
    await daemon.runSyncOnce();
    expect(await daemon.storage.getTask('b')).not.toBeNull();
    expect((await daemon.storage.getTask('a'))!.disabled).toBe(true);

    // file broken at runtime → sync skipped, daemon alive, last good state kept
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFileSync(tasksPath, '{ not json');
    await daemon.runSyncOnce();
    expect(await daemon.storage.getTask('b')).not.toBeNull(); // still present — last good state
    expect(logSpy).toHaveBeenCalled(); // broken-file log, not a crash
    logSpy.mockRestore();
    daemon.stop();
  });

  it('drives runSyncOnce on the sync interval (default 60s)', async () => {
    vi.useFakeTimers();
    try {
      const dir = mkdtempSync(join(tmpdir(), 'sched-synctimer-'));
      const tasksPath = join(dir, 'tasks.json');
      writeFileSync(tasksPath, JSON.stringify({ tasks: [] }));
      const { runner } = makeRunner();
      const daemon = createDaemon({
        tasksPath,
        dbPath: ':memory:',
        runners: { test: runner },
        now: () => NOW,
        syncIntervalMs: 60_000,
      });
      const spy = vi.spyOn(daemon, 'runSyncOnce').mockResolvedValue(undefined);
      await daemon.start();
      expect(spy).not.toHaveBeenCalled(); // startup sync is direct, not via the timer
      await vi.advanceTimersByTimeAsync(60_000);
      expect(spy).toHaveBeenCalledTimes(1);
      daemon.stop();
      spy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails fast at start when a task uses an unimplemented runner', async () => {
    const daemon = createDaemon({ tasksPath: UNKNOWN_FIXTURE, dbPath: ':memory:', now: () => NOW });
    await expect(daemon.start()).rejects.toThrow(/kafka/);
  });

  it('registers the docker runner by default (v2: docker tasks are valid at start)', async () => {
    const daemon = createDaemon({ tasksPath: DOCKER_FIXTURE, dbPath: ':memory:', now: () => NOW });
    await expect(daemon.start()).resolves.toBeUndefined();
    const tasks = await daemon.storage.listTasks();
    expect(tasks[0]!.runner).toBe('docker');
    daemon.stop();
  });

  it('aborts startup when a docker task image is outside the runner allowlist (load-time validation)', async () => {
    const daemon = createDaemon({
      tasksPath: DOCKER_FIXTURE,
      dbPath: ':memory:',
      runners: { docker: createDockerRunner({ allowedTools: ['alpine:*'] }) },
    });
    await expect(daemon.start()).rejects.toThrow(/allowedTools/);
    daemon.stop();
  });

  it('starts when the docker task image is allowlisted', async () => {
    const daemon = createDaemon({
      tasksPath: DOCKER_FIXTURE,
      dbPath: ':memory:',
      runners: { docker: createDockerRunner({ allowedTools: ['busybox:*'] }) },
    });
    await expect(daemon.start()).resolves.toBeUndefined();
    daemon.stop();
  });

  it('exposes pollTimeoutMs via DaemonOptions — a hung async run fails on time', async () => {
    const worker = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'running' }));
    });
    await new Promise<void>((r) => worker.listen(0, '127.0.0.1', () => r()));
    const port = (worker.address() as AddressInfo).port;
    const daemon = createDaemon({
      tasksPath: ACCEPT_FIXTURE,
      dbPath: ':memory:',
      pollTimeoutMs: 250,
      runners: {
        accept: {
          async run(): Promise<RunOutcome> {
            return { status: 'accepted', statusUrl: `http://127.0.0.1:${port}/status`, pollIntervalMs: 10 };
          },
          // hung worker: polls keep reporting running — only the deadline stops the run
          async poll() {
            return { status: 'running' };
          },
        },
      },
    });
    await daemon.start();
    // The global pollTimeoutMs governs tasks with timeoutMs: null (legacy rows
    // / pre-0.46 storage). A tasks.json task WITHOUT timeoutMs now defaults to
    // -1 = never auto-terminate (operator contract 2026-08-20) — it bypasses
    // the global ceiling, so seed the legacy shape explicitly.
    const task = (await daemon.storage.getTask('accept-task'))!;
    await daemon.storage.upsertTask({ ...task, timeoutMs: null });
    await daemon.engine.triggerTask('accept-task');

    const deadline = Date.now() + 8000;
    let failedOnTimeout = false;
    while (Date.now() < deadline) {
      const runs = await daemon.storage.listRuns({ limit: 10 });
      if (runs.some((r) => r.status === 'failed' && String(r.error ?? '').includes('poll timeout'))) {
        failedOnTimeout = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(failedOnTimeout).toBe(true);
    daemon.stop();
    worker.close();
  });

  it('forwards cancel to the per-task runner for accepted runs with a cancelUrl', async () => {
    const worker = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'running' }));
    });
    await new Promise<void>((r) => worker.listen(0, '127.0.0.1', () => r()));
    const port = (worker.address() as AddressInfo).port;
    let cancelCalled: { runId: string; cancelUrl: string } | null = null;
    const daemon = createDaemon({
      tasksPath: ACCEPT_FIXTURE,
      dbPath: ':memory:',
      runners: {
        accept: {
          async run(): Promise<RunOutcome> {
            return {
              status: 'accepted',
              statusUrl: `http://127.0.0.1:${port}/status`,
              cancelUrl: `http://127.0.0.1:${port}/cancel`,
              pollIntervalMs: 10_000,
            };
          },
          async poll() {
            return { status: 'running' };
          },
          async cancel(runId: string, _statusUrl: string, _task?: unknown, cancelUrl?: string | null) {
            cancelCalled = { runId, cancelUrl: cancelUrl ?? '' };
          },
        },
      },
    });
    await daemon.start();
    await daemon.engine.triggerTask('accept-task');
    const runs = await daemon.storage.listRuns({ limit: 5 });
    const run = runs.find((r) => r.status === 'queued') ?? runs[0]!;

    await daemon.engine.cancelRun(run.id);

    // regression: the daemon dispatcher must forward cancel to the per-task
    // runner — before the fix `runner.cancel` was undefined at the engine, so
    // the cancelUrl channel was dead through the daemon (signal never sent,
    // run cancelled with plain 'cancelled by user' — battle-stand symptom
    // 2026-08-21: worker kept running after cancel).
    expect(cancelCalled).toEqual({ runId: run.id, cancelUrl: `http://127.0.0.1:${port}/cancel` });
    expect((await daemon.storage.getRun(run.id))!.status).toBe('cancelled');
    daemon.stop();
    worker.close();
  });

  it('passes retention options to the engine (runRetentionOnce prunes daemon storage)', async () => {
    const { runner } = makeRunner();
    const daemon = createDaemon({
      tasksPath: FIXTURE,
      dbPath: ':memory:',
      runners: { test: runner },
      now: () => NOW,
      temporaryRetentionMs: 3_600_000, // 1h
      retentionMs: 86_400_000, // 1d
    });
    await daemon.start();

    await daemon.storage.createRun({
      id: 'old-temp',
      taskName: 'daily',
      runner: 'test',
      startedAt: new Date('2026-08-16T08:00:00Z'),
      finishedAt: new Date('2026-08-16T10:00:00Z'), // 2h ago → past the 1h temp TTL
      status: 'succeeded',
      data: null,
      result: null,
      error: null,
      progress: null,
      log: null,
      artifacts: null,
      workerRef: null,
      attempt: 1,
      trigger: 'schedule',
      triggeredBy: null,
      scheduleId: null,
      temporary: true,
      retryOf: null,
    });
    await daemon.storage.createRun({
      id: 'fresh',
      taskName: 'daily',
      runner: 'test',
      startedAt: new Date('2026-08-16T11:30:00Z'),
      finishedAt: new Date('2026-08-16T11:45:00Z'),
      status: 'failed',
      data: null,
      result: null,
      error: 'x',
      progress: null,
      log: null,
      artifacts: null,
      workerRef: null,
      attempt: 1,
      trigger: 'schedule',
      triggeredBy: null,
      scheduleId: null,
      temporary: false,
      retryOf: null,
    });

    await daemon.engine.runRetentionOnce();

    expect(await daemon.storage.getRun('old-temp')).toBeNull();
    expect(await daemon.storage.getRun('fresh')).not.toBeNull();
    daemon.stop();
  });

  it('retention 0 = off: old runs survive runRetentionOnce (prod defect 6, regression for the 0-falsy drop)', async () => {
    // Regression for the 0-falsy bug (incident #1035 / books prod): `retentionMs ? …`
    // dropped the 0 value, the engine fell back to the 30d default, and the first
    // hourly pass pruned the operator's archive. `0` must reach the engine and
    // pruneRuns must NOT run for either class.
    const { runner } = makeRunner();
    const daemon = createDaemon({
      tasksPath: FIXTURE,
      dbPath: ':memory:',
      runners: { test: runner },
      now: () => NOW,
      temporaryRetentionMs: 0, // retention off for temporary runs
      retentionMs: 0, // retention off for regular runs
    });
    await daemon.start();

    const oldRun = (id: string, temporary: boolean, startedAt: string, finishedAt: string) =>
      daemon.storage.createRun({
        id,
        taskName: 'daily',
        runner: 'test',
        startedAt: new Date(startedAt),
        finishedAt: new Date(finishedAt),
        status: 'succeeded',
        data: null,
        result: null,
        error: null,
        progress: null,
        log: null,
        artifacts: null,
        workerRef: null,
        attempt: 1,
        trigger: 'schedule',
        triggeredBy: null,
        scheduleId: null,
        temporary,
        retryOf: null,
      });
    await oldRun('old-regular', false, '2026-07-01T08:00:00Z', '2026-07-01T10:00:00Z'); // 46d old
    await oldRun('old-temp', true, '2026-07-01T08:00:00Z', '2026-07-01T10:00:00Z'); // 46d old

    await daemon.engine.runRetentionOnce();

    // Both classes survive: 0 = retention disabled, not a 0ms TTL.
    expect(await daemon.storage.getRun('old-regular')).not.toBeNull();
    expect(await daemon.storage.getRun('old-temp')).not.toBeNull();
    daemon.stop();
  });

  it('builds default runners with the tasks.json runners block (sandbox ceiling), failing fast at start', async () => {
    // a process task whose command is outside the ceiling → start rejects (policy before mechanics)
    const evil = createDaemon({ tasksPath: SANDBOX_EVIL_FIXTURE, dbPath: ':memory:', now: () => NOW });
    await expect(evil.start()).rejects.toThrow(/allowedTools/);

    // a process task inside the ceiling → starts fine
    const ok = createDaemon({ tasksPath: SANDBOX_OK_FIXTURE, dbPath: ':memory:', now: () => NOW });
    await expect(ok.start()).resolves.toBeUndefined();
    ok.stop();
  });

  it('an embedded runners override wins over the tasks.json runners block', async () => {
    const { runner } = makeRunner();
    // the file's runners block is malformed (allowedTools is a string) — if the
    // daemon consulted it, createDaemon would throw; the override proves it's ignored
    const daemon = createDaemon({
      tasksPath: SANDBOX_IGNORED_FIXTURE,
      dbPath: ':memory:',
      runners: { test: runner },
      now: () => NOW,
    });
    await expect(daemon.start()).resolves.toBeUndefined();
    daemon.stop();
  });

  it('delegates poll() to the runner impl (v2 async envelope through the daemon)', async () => {
    const pollCalls: Array<{ runId: string; statusUrl: string }> = [];
    const asyncRunner: Runner = {
      async run(): Promise<RunOutcome> {
        return { status: 'accepted', statusUrl: 'http://worker:3000/status/r1', pollIntervalMs: 5 };
      },
      async poll(runId: string, statusUrl: string): Promise<PollResult> {
        pollCalls.push({ runId, statusUrl });
        return { status: 'succeeded', result: { ok: true } };
      },
    };
    const daemon = createDaemon({ tasksPath: FIXTURE, dbPath: ':memory:', runners: { test: asyncRunner }, now: () => NOW });

    await daemon.start();
    // every-minute fires at 12:02 → accepted (async branch)
    await daemon.engine.runOnce(new Date('2026-08-16T12:02:00Z'));
    // poll loop resolves the queued run → succeeded
    await daemon.engine.runPollOnce(new Date('2026-08-16T12:02:01Z'));

    expect(pollCalls).toHaveLength(1);
    expect(pollCalls[0]!.statusUrl).toBe('http://worker:3000/status/r1');
    // task completed after the poll resolved — not left claimed
    const task = await daemon.storage.getTask('every-minute');
    expect(task!.nextRunAt).not.toBeNull();
    daemon.stop();
  });
});

describe('daemon — alerts from tasks.json', () => {
  /** Local HTTP sink collecting POST bodies. */
  async function sink(): Promise<{ server: ReturnType<typeof createServer>; port: number; bodies: string[] }> {
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        bodies.push(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    return { server, port, bodies };
  }

  it('reads the top-level alerts block and POSTs a run failure to the webhook', async () => {
    const s = await sink();
    try {
      const dir = mkdtempSync(join(tmpdir(), 'sched-alerts-'));
      const tasksPath = join(dir, 'tasks.json');
      writeFileSync(
        tasksPath,
        JSON.stringify({
          tasks: [{ name: 'failer', runner: 'test', config: {}, schedules: [{ cron: '* * * * *' }] }],
          alerts: { webhook: { url: `http://127.0.0.1:${s.port}/hook` } },
        }),
      );
      const daemon = createDaemon({
        tasksPath,
        dbPath: ':memory:',
        runners: { test: { async run() { return { status: 'failed' as const, error: 'boom' }; } } },
        now: () => new Date('2026-08-16T12:00:00Z'),
      });
      await daemon.start();
      await daemon.engine.runOnce(new Date('2026-08-16T12:02:00Z'));
      daemon.stop();

      expect(s.bodies).toHaveLength(1);
      const payload = JSON.parse(s.bodies[0]!) as Record<string, unknown>;
      expect(payload.event).toBe('run.failed');
      expect(payload.task).toEqual({ name: 'failer', runner: 'test' });
      expect((payload.run as Record<string, unknown>).error).toBe('boom');
    } finally {
      s.server.close();
    }
  });

  it('POSTs run.failed for an ASYNC http-runner run (accepted → poll failed) — the 0.12.1 alert path (task:1390)', async () => {
    // fake worker: accepts the dispatch (202 + statusUrl), then reports failure on poll
    let worker: ReturnType<typeof createServer> | null = null;
    const port = await new Promise<number>((resolve) => {
      worker = createServer((req, res) => {
        req.resume();
        if (req.method === 'POST') {
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'accepted', statusUrl: `http://127.0.0.1:${(worker!.address() as AddressInfo).port}/status`, pollIntervalMs: 5 }));
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'failed', error: 'worker exploded' }));
        }
      });
      worker.listen(0, '127.0.0.1', () => resolve((worker!.address() as AddressInfo).port));
    });
    const s = await sink();
    try {
      const dir = mkdtempSync(join(tmpdir(), 'sched-alerts-http-'));
      const tasksPath = join(dir, 'tasks.json');
      writeFileSync(
        tasksPath,
        JSON.stringify({
          tasks: [
            {
              name: 'http-failer',
              runner: 'http',
              config: { url: `http://127.0.0.1:${port}/run`, envelope: true },
              schedules: [{ cron: '* * * * *' }],
            },
          ],
          alerts: { webhook: { url: `http://127.0.0.1:${s.port}/hook` } },
        }),
      );
      const daemon = createDaemon({ tasksPath, dbPath: ':memory:', now: () => new Date('2026-08-16T12:00:00Z') });
      await daemon.start();
      await daemon.engine.runOnce(new Date('2026-08-16T12:02:00Z'));
      await daemon.engine.runPollOnce(new Date('2026-08-16T12:02:01Z'));
      daemon.stop();

      expect(s.bodies).toHaveLength(1);
      const payload = JSON.parse(s.bodies[0]!) as Record<string, unknown>;
      expect(payload.event).toBe('run.failed');
      expect(payload.task).toEqual({ name: 'http-failer', runner: 'http' });
    } finally {
      worker!.close();
      s.server.close();
    }
  });

  it('programmatic options.alerts wins over the tasks.json alerts block', async () => {
    const fileSink = await sink();
    const optSink = await sink();
    try {
      const dir = mkdtempSync(join(tmpdir(), 'sched-alerts-'));
      const tasksPath = join(dir, 'tasks.json');
      writeFileSync(
        tasksPath,
        JSON.stringify({
          tasks: [{ name: 'failer', runner: 'test', config: {}, schedules: [{ cron: '* * * * *' }] }],
          alerts: { webhook: { url: `http://127.0.0.1:${fileSink.port}/hook` } },
        }),
      );
      const daemon = createDaemon({
        tasksPath,
        dbPath: ':memory:',
        alerts: { webhook: { url: `http://127.0.0.1:${optSink.port}/hook` } },
        runners: { test: { async run() { return { status: 'failed' as const, error: 'boom' }; } } },
        now: () => new Date('2026-08-16T12:00:00Z'),
      });
      await daemon.start();
      await daemon.engine.runOnce(new Date('2026-08-16T12:02:00Z'));
      daemon.stop();

      expect(optSink.bodies).toHaveLength(1);
      expect(fileSink.bodies).toHaveLength(0);
    } finally {
      fileSink.server.close();
      optSink.server.close();
    }
  });

  it('sync-failure detection: a broken tasks.json POSTs sync.failed once, dedupes the streak, resets on heal', async () => {
    const s = await sink();
    try {
      const dir = mkdtempSync(join(tmpdir(), 'sched-alerts-syncfail-'));
      const tasksPath = join(dir, 'tasks.json');
      writeFileSync(tasksPath, JSON.stringify({ tasks: [{ name: 'a', runner: 'test', config: {} }] }));
      const daemon = createDaemon({
        tasksPath,
        dbPath: ':memory:',
        alerts: { webhook: { url: `http://127.0.0.1:${s.port}/hook` } },
        runners: { test: { async run() { return { status: 'succeeded' as const }; } } },
        now: () => new Date('2026-08-16T12:00:00Z'),
      });
      await daemon.start();
      expect(s.bodies).toHaveLength(0); // healthy start → no alert

      // file broken → first sync-failed alert
      writeFileSync(tasksPath, '{ not json');
      await daemon.runSyncOnce();
      expect(s.bodies).toHaveLength(1);
      const first = JSON.parse(s.bodies[0]!) as Record<string, unknown>;
      expect(first.event).toBe('sync.failed');
      expect(first.consecutiveFailures).toBe(1);

      // still broken → streak continues, deduped (no 60s spam)
      await daemon.runSyncOnce();
      await daemon.runSyncOnce();
      expect(s.bodies).toHaveLength(1);

      // file heals → streak resets; next break alerts again
      writeFileSync(tasksPath, JSON.stringify({ tasks: [{ name: 'a', runner: 'test', config: {} }] }));
      await daemon.runSyncOnce();
      writeFileSync(tasksPath, '{ still broken');
      await daemon.runSyncOnce();
      expect(s.bodies).toHaveLength(2);
      const second = JSON.parse(s.bodies[1]!) as Record<string, unknown>;
      expect(second.event).toBe('sync.failed');
      expect(second.consecutiveFailures).toBe(1); // fresh streak

      daemon.stop();
    } finally {
      s.server.close();
    }
  });

  it('onSyncFailed: false silences sync alerts entirely', async () => {
    const s = await sink();
    try {
      const dir = mkdtempSync(join(tmpdir(), 'sched-alerts-syncfail-off-'));
      const tasksPath = join(dir, 'tasks.json');
      writeFileSync(tasksPath, JSON.stringify({ tasks: [{ name: 'a', runner: 'test', config: {} }] }));
      const daemon = createDaemon({
        tasksPath,
        dbPath: ':memory:',
        alerts: { webhook: { url: `http://127.0.0.1:${s.port}/hook` }, onSyncFailed: false },
        runners: { test: { async run() { return { status: 'succeeded' as const }; } } },
        now: () => new Date('2026-08-16T12:00:00Z'),
      });
      await daemon.start();

      writeFileSync(tasksPath, '{ not json');
      await daemon.runSyncOnce();
      await daemon.runSyncOnce();
      expect(s.bodies).toHaveLength(0);

      daemon.stop();
    } finally {
      s.server.close();
    }
  });
});
