import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEngine } from '../src/engine.js';
import { makeTask } from '../src/storage-contract.js';
import { MemoryStorage } from './helpers/memory-storage.js';
import { createFileRunner } from './helpers/file-runner.js';

const NOON = new Date('2026-08-16T12:00:00Z');

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'sched-file-runner-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface JobEnvelope {
  runId: string;
  taskName: string;
  config: unknown;
  startedAt: string;
}

/** Polls the inbox for the job file and hands it to `onJob` (the "worker"). */
function startWorker(dir: string, onJob: (job: JobEnvelope) => void): Promise<void> {
  return new Promise((resolve) => {
    const iv = setInterval(() => {
      const name = readdirSync(dir).find((f) => f.startsWith('job-') && f.endsWith('.json'));
      if (!name) return;
      clearInterval(iv);
      const job = JSON.parse(readFileSync(join(dir, name), 'utf8')) as JobEnvelope;
      onJob(job);
      resolve();
    }, 5);
  });
}

const writeResult = (dir: string, runId: string, body: unknown) =>
  writeFileSync(join(dir, `${runId}.result.json`), JSON.stringify(body));

describe('createFileRunner', () => {
  const mkTask = (config: Record<string, unknown>) =>
    makeTask({ runner: 'file', config, nextRunAt: new Date('2026-08-16T11:59:00Z') });

  it('validateConfig: rejects a missing dir (daemon aborts startup), accepts an existing one', () => {
    const runner = createFileRunner();
    const missing = mkTask({ dir: join(tmpDir(), 'nope') });
    expect(() => runner.validateConfig?.(missing)).toThrow(/does not exist/);
    const ok = mkTask({ dir: tmpDir() });
    expect(() => runner.validateConfig?.(ok)).not.toThrow();
  });

  it('run: drops the job file, worker writes a result → succeeded with result/log, job file cleaned up', async () => {
    const dir = tmpDir();
    const runner = createFileRunner({ pollMs: 5, timeoutMs: 2000 });
    const worker = startWorker(dir, (job) => {
      expect(job.config).toEqual({ dir });
      expect(job.startedAt).toBe(NOON.toISOString());
      writeResult(dir, job.runId, { status: 'succeeded', result: { rows: 42 }, log: 'done in 3s' });
    });

    const outcome = await runner.run!(mkTask({ dir }), 'run-1', NOON);
    await worker;

    expect(outcome).toEqual({ status: 'succeeded', result: { rows: 42 }, log: 'done in 3s' });
    expect(readdirSync(dir).filter((f) => f.includes('run-1'))).toEqual([]); // no leftovers
  });

  it('run: worker reports failure → failed with the worker error', async () => {
    const dir = tmpDir();
    const runner = createFileRunner({ pollMs: 5, timeoutMs: 2000 });
    const worker = startWorker(dir, (job) => writeResult(dir, job.runId, { status: 'failed', error: 'exit 1' }));
    const outcome = await runner.run!(mkTask({ dir }), 'run-2', NOON);
    await worker;
    expect(outcome).toEqual({ status: 'failed', error: 'exit 1' });
  });

  it('run: no result file before the timeout → failed with a clear message', async () => {
    const dir = tmpDir();
    const runner = createFileRunner({ pollMs: 5, timeoutMs: 50 });
    const outcome = await runner.run!(mkTask({ dir }), 'run-3', NOON);
    expect(outcome.status).toBe('failed');
    expect((outcome as { error: string }).error).toMatch(/no result file after 50ms/);
    expect(readdirSync(dir).filter((f) => f.includes('run-3'))).toEqual([]); // job file cleaned up
  });

  it('run: abort mid-flight rejects with AbortError and removes the job file', async () => {
    const dir = tmpDir();
    const runner = createFileRunner({ pollMs: 5, timeoutMs: 5000 });
    const ac = new AbortController();
    const worker = startWorker(dir, () => {}); // worker never writes a result
    const runP = runner.run!(mkTask({ dir }), 'run-4', NOON, { signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    await expect(runP).rejects.toMatchObject({ name: 'AbortError' });
    await worker;
    expect(readdirSync(dir).filter((f) => f.includes('run-4'))).toEqual([]);
  });

  it('run: signal already aborted → cancelled outcome, no job file written', async () => {
    const dir = tmpDir();
    const runner = createFileRunner({ pollMs: 5 });
    const ac = new AbortController();
    ac.abort();
    const outcome = await runner.run!(mkTask({ dir }), 'run-5', NOON, { signal: ac.signal });
    expect(outcome).toEqual({ status: 'cancelled', error: 'aborted before dispatch' });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('run: progress file → onProgress is called with the value', async () => {
    const dir = tmpDir();
    const runner = createFileRunner({ pollMs: 5, timeoutMs: 2000 });
    const seen: number[] = [];
    const worker = startWorker(dir, (job) => {
      writeFileSync(join(dir, `${job.runId}.progress.json`), JSON.stringify({ progress: 50 }));
      writeResult(dir, job.runId, { status: 'succeeded' });
    });
    await runner.run!(mkTask({ dir }), 'run-6', NOON, {
      onProgress: (p) => {
        seen.push(p);
      },
    });
    await worker;
    expect(seen).toContain(50);
  });

  it('run: malformed result JSON → failed instead of throwing', async () => {
    const dir = tmpDir();
    const runner = createFileRunner({ pollMs: 5, timeoutMs: 2000 });
    const worker = startWorker(dir, (job) => writeFileSync(join(dir, `${job.runId}.result.json`), '{nope'));
    const outcome = await runner.run!(mkTask({ dir }), 'run-7', NOON);
    await worker;
    expect(outcome.status).toBe('failed');
    expect((outcome as { error: string }).error).toMatch(/not valid JSON/);
  });
});

describe('file runner — engine integration', () => {
  async function seedTask(dir: string) {
    const storage = new MemoryStorage();
    await storage.upsertTask(makeTask({ runner: 'file', config: { dir }, nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    await storage.createSchedule({
      id: 'task-a',
      taskName: 'task-a',
      schedule: { kind: 'interval', ms: 3_600_000 },
      tz: 'UTC',
      data: null,
      externalId: null,
      dedupKey: null,
      nextRunAt: new Date('2026-08-16T11:59:00Z'),
      lastRunAt: null,
      lockedAt: null,
      failCount: 0,
      priority: 0,
      retry: null,
      retryCount: 0,
      lastRunId: null,
      paused: false,
      disabled: false,
      fileManaged: true,
    });
    return storage;
  }

  it('dispatch → worker result → run record finished (full seam)', async () => {
    const dir = tmpDir();
    const storage = await seedTask(dir);
    const engine = createEngine({
      storage,
      runner: createFileRunner({ pollMs: 5, timeoutMs: 2000 }),
      now: () => NOON,
    });

    const worker = startWorker(dir, (job) =>
      writeResult(dir, job.runId, { status: 'succeeded', result: { handled: job.runId }, log: 'ok' }),
    );
    await engine.runOnce();
    await worker;

    const [run] = [...storage.runs.values()];
    expect(run!.status).toBe('succeeded');
    expect(run!.runner).toBe('file');
    expect(run!.result).toEqual({ handled: run!.id });
    expect(run!.log).toBe('ok');
    expect((await storage.getSchedule('task-a'))!.lockedAt).toBeNull(); // lock released
  });

  it('cancelRun aborts the file runner mid-wait → run cancelled, job file gone', async () => {
    const dir = tmpDir();
    const storage = await seedTask(dir);
    const engine = createEngine({
      storage,
      runner: createFileRunner({ pollMs: 5, timeoutMs: 10_000 }),
      now: () => NOON,
    });

    const worker = startWorker(dir, () => {}); // worker never finishes
    const tick = engine.runOnce();
    // wait until the job file exists (the runner is now polling for a result)
    const jobAppeared = new Promise<void>((resolve) => {
      const iv = setInterval(() => {
        if (readdirSync(dir).some((f) => f.startsWith('job-'))) {
          clearInterval(iv);
          resolve();
        }
      }, 5);
    });
    await jobAppeared;

    const run = [...storage.runs.values()][0]!;
    const cancelled = await engine.cancelRun(run.id);
    expect(cancelled!.status).toBe('cancelled');
    await tick;
    await worker;
    expect(readdirSync(dir).filter((f) => f.includes(run.id))).toEqual([]); // job file cleaned up
  });
});
