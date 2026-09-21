import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdminApi } from '@schedjs/admin-api';
import { createEngine, createSqliteStorage } from '@schedjs/core';
import type { TaskRecord } from '@schedjs/core';
import { createAdminFixture } from './fixtures/admin.mjs';

/**
 * Contract tests: spawn the compiled @schedjs/cli bin against a fixture admin
 * API and assert on exit codes (0 ok / 1 api/network error / 2 usage) + JSON.
 * Requires `yarn workspace @schedjs/cli build` first (dist/index.js is the bin).
 */
const BIN = fileURLToPath(new URL('../dist/index.js', import.meta.url));

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], opts: { env?: Record<string, string> } = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function task(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    runner: 'http',
    schedule: { kind: 'cron', cron: '0 9 * * *' },
    tz: 'UTC',
    config: {},
    label: null,
    description: null,
    nextRunAt: '2026-08-19T09:00:00.000Z',
    lastRunAt: null,
    lockedAt: null,
    failCount: 0,
    priority: 0,
    retry: null,
    retryCount: 0,
    lastRunId: null,
    paused: false,
    disabled: false,
    ...overrides,
  };
}

function run(id: string, taskName: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    taskName,
    runner: 'http',
    startedAt: '2026-08-18T09:00:00.000Z',
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
    ...overrides,
  };
}

function schedule(id: string, taskName: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    taskName,
    schedule: { kind: 'cron', cron: '0 9 * * *' },
    tz: 'UTC',
    data: null,
    externalId: null,
    dedupKey: null,
    nextRunAt: '2026-08-19T09:00:00.000Z',
    lastRunAt: null,
    lockedAt: null,
    failCount: 0,
    priority: 0,
    retry: null,
    retryCount: 0,
    lastRunId: null,
    paused: false,
    disabled: false,
    ...overrides,
  };
}

describe('@schedjs/cli contract (spawn bin → fixture admin api)', () => {
  let fixture: ReturnType<typeof createAdminFixture>;
  let port: number;
  let base: string;

  beforeAll(async () => {
    fixture = createAdminFixture();
    port = await fixture.listen();
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await fixture.close();
  });

  beforeEach(() => {
    fixture.clearLog();
  });

  it('status --json: daemon health + counts, exit 0', async () => {
    fixture.seed({
      tasks: [task('a')],
      runs: [run('r1', 'a', { status: 'failed' }), run('r2', 'a', { status: 'succeeded' })],
      schedules: [schedule('s1', 'a')],
    });
    const res = await runCli(['status', '--json', '--admin-url', base]);
    expect(res.code).toBe(0);
    const body = JSON.parse(res.stdout);
    expect(body.ok).toBe(true);
    expect(body.version).toBe('9.9.9-fixture');
    expect(body.tasks).toBe(1);
    expect(body.schedules).toBe(1);
    expect(body.failedRuns).toBe(1);
  });

  it('tasks --json: passes the API list through untouched, exit 0', async () => {
    fixture.seed({ tasks: [task('sync-seller'), task('nightly')] });
    const res = await runCli(['tasks', '--json', '--admin-url', base]);
    expect(res.code).toBe(0);
    const body = JSON.parse(res.stdout);
    expect(body.tasks.map((t: { name: string }) => t.name)).toEqual(['sync-seller', 'nightly']);
  });

  it('runs --json with filters: forwards task/status/limit params, exit 0', async () => {
    fixture.seed({
      runs: [
        run('r1', 'a', { status: 'failed' }),
        run('r2', 'a', { status: 'succeeded' }),
        run('r3', 'b', { status: 'failed' }),
      ],
    });
    const res = await runCli(['runs', '--task', 'a', '--status', 'failed', '--limit', '5', '--json', '--admin-url', base]);
    expect(res.code).toBe(0);
    const body = JSON.parse(res.stdout);
    expect(body.runs.map((r: { id: string }) => r.id)).toEqual(['r1']);
    const log = fixture.requests();
    const runsReq = log.find((r) => r.path.startsWith('/runs'));
    expect(runsReq?.path).toContain('task=a');
    expect(runsReq?.path).toContain('status=failed');
  });

  it('schedules --json: lists schedules, exit 0', async () => {
    fixture.seed({ schedules: [schedule('s1', 'sync-seller')] });
    const res = await runCli(['schedules', '--json', '--admin-url', base]);
    expect(res.code).toBe(0);
    const body = JSON.parse(res.stdout);
    expect(body.schedules[0].id).toBe('s1');
  });

  it('trigger <task> --json: POSTs /tasks/:name/run and prints the run, exit 0', async () => {
    fixture.seed({ tasks: [task('sync-seller')] });
    const res = await runCli(['trigger', 'sync-seller', '--json', '--admin-url', base]);
    expect(res.code).toBe(0);
    const body = JSON.parse(res.stdout);
    expect(body.run.taskName).toBe('sync-seller');
    expect(body.run.status).toBe('queued');
    const log = fixture.requests();
    expect(log.some((r) => r.method === 'POST' && r.path === '/tasks/sync-seller/run')).toBe(true);
  });

  it('trigger with --data: sends the JSON body to the run endpoint', async () => {
    fixture.seed({ tasks: [task('sync-seller')] });
    const res = await runCli(['trigger', 'sync-seller', '--data', '{"idSeller":2}', '--json', '--admin-url', base]);
    expect(res.code).toBe(0);
    const body = JSON.parse(res.stdout);
    expect(body.run.data).toEqual({ idSeller: 2 });
  });

  it('pause/resume <task>: exits 0 and hits the task endpoints', async () => {
    fixture.seed({ tasks: [task('a')] });
    const pause = await runCli(['pause', 'a', '--json', '--admin-url', base]);
    expect(pause.code).toBe(0);
    const resume = await runCli(['resume', 'a', '--json', '--admin-url', base]);
    expect(resume.code).toBe(0);
    const log = fixture.requests();
    expect(log.some((r) => r.method === 'POST' && r.path === '/tasks/a/pause')).toBe(true);
    expect(log.some((r) => r.method === 'POST' && r.path === '/tasks/a/resume')).toBe(true);
  });

  it('pause/resume --schedule <id>: hits the schedule endpoints', async () => {
    fixture.seed({ schedules: [schedule('sch-1', 'a')] });
    const pause = await runCli(['pause', '--schedule', 'sch-1', '--json', '--admin-url', base]);
    expect(pause.code).toBe(0);
    const resume = await runCli(['resume', '--schedule', 'sch-1', '--json', '--admin-url', base]);
    expect(resume.code).toBe(0);
    const log = fixture.requests();
    expect(log.some((r) => r.method === 'POST' && r.path === '/schedules/sch-1/pause')).toBe(true);
    expect(log.some((r) => r.method === 'POST' && r.path === '/schedules/sch-1/resume')).toBe(true);
  });

  it('API error (404 unknown task): exit 1, --json error is JSON on stdout (F7)', async () => {
    fixture.seed({ tasks: [] });
    const res = await runCli(['trigger', 'ghost', '--json', '--admin-url', base]);
    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.stdout) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('task ghost not found');
  });

  it('auth: without --api-key → 401 → exit 1 (JSON error); with key → exit 0', async () => {
    const authed = createAdminFixture({ key: 'secret-123' });
    const authedPort = await authed.listen();
    try {
      const noKey = await runCli(['tasks', '--json', '--admin-url', `http://127.0.0.1:${authedPort}`]);
      expect(noKey.code).toBe(1);
      expect((JSON.parse(noKey.stdout) as { error: string }).error).toContain('401');
      const withKey = await runCli(['tasks', '--json', '--admin-url', `http://127.0.0.1:${authedPort}`, '--api-key', 'secret-123']);
      expect(withKey.code).toBe(0);
    } finally {
      await authed.close();
    }
  });

  it('SCHED_ADMIN_KEY env: used when --api-key is absent', async () => {
    const authed = createAdminFixture({ key: 'env-secret' });
    const authedPort = await authed.listen();
    try {
      const res = await runCli(['status', '--json', '--admin-url', `http://127.0.0.1:${authedPort}`], {
        env: { SCHED_ADMIN_KEY: 'env-secret' },
      });
      expect(res.code).toBe(0);
    } finally {
      await authed.close();
    }
  });

  it('usage errors → exit 2', async () => {
    const unknown = await runCli(['bogus', '--admin-url', base]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('unknown command');

    const missingArg = await runCli(['trigger', '--admin-url', base]);
    expect(missingArg.code).toBe(2);

    const badFlag = await runCli(['tasks', '--admin-url', 'not-a-url', '--json']);
    expect(badFlag.code).toBe(2);
  });

  it('F4: runs --limit abc → exit 2 (value validation, not silent full list)', async () => {
    const res = await runCli(['runs', '--limit', 'abc', '--admin-url', base]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('--limit');
  });

  it('F4: runs --status succeded (typo) → exit 2', async () => {
    const res = await runCli(['runs', '--status', 'succeded', '--admin-url', base]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('--status');
  });

  describe('R4 — runs window/runner filters', () => {
    const query = (path: string) => new URLSearchParams(path.split('?')[1] ?? '');
    const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

    it('--since 24h --until 2h --runner docker: relative forms resolve to ISO-8601 on the wire', async () => {
      fixture.seed({ runs: [] });
      const res = await runCli(['runs', '--since', '24h', '--until', '2h', '--runner', 'docker', '--json', '--admin-url', base]);
      expect(res.code).toBe(0);
      const body = JSON.parse(res.stdout) as { runs: unknown[]; filter: Record<string, string> };

      const req = fixture.requests().find((r) => r.path.startsWith('/runs'));
      const qs = query(req!.path);
      expect(qs.get('runner')).toBe('docker');
      expect(qs.get('since')).toMatch(TIMESTAMP);
      expect(qs.get('until')).toMatch(TIMESTAMP);
      const since = new Date(qs.get('since')!).getTime();
      const until = new Date(qs.get('until')!).getTime();
      const now = Date.now();
      expect(Math.abs(now - since - 24 * 3_600_000)).toBeLessThan(300_000);
      expect(Math.abs(now - until - 2 * 3_600_000)).toBeLessThan(300_000);
      expect(since).toBeLessThan(until);

      // --json echoes the RESOLVED filter — the relative form is machine-visible
      expect(body.filter).toEqual({ since: qs.get('since'), until: qs.get('until'), runner: 'docker' });
    });

    it('--since 7d (week form) and an ISO timestamp pass through as ISO', async () => {
      fixture.seed({ runs: [] });
      const week = await runCli(['runs', '--since', '7d', '--json', '--admin-url', base]);
      expect(week.code).toBe(0);
      const weekSince = new Date(query(fixture.requests().find((r) => r.path.startsWith('/runs'))!.path).get('since')!).getTime();
      expect(Math.abs(Date.now() - weekSince - 7 * 86_400_000)).toBeLessThan(300_000);

      fixture.clearLog();
      const iso = await runCli(['runs', '--since', '2026-01-01T00:00:00Z', '--json', '--admin-url', base]);
      expect(iso.code).toBe(0);
      const isoSince = query(fixture.requests().find((r) => r.path.startsWith('/runs'))!.path).get('since');
      expect(isoSince).toBe('2026-01-01T00:00:00.000Z');
    });

    it('--since banana → exit 2 (usage, not a silent unfiltered list)', async () => {
      const res = await runCli(['runs', '--since', 'banana', '--admin-url', base]);
      expect(res.code).toBe(2);
      expect(res.stderr).toContain('--since');
    });

    it('--since 2h --until 24h (inverted window) → exit 2', async () => {
      const res = await runCli(['runs', '--since', '2h', '--until', '24h', '--admin-url', base]);
      expect(res.code).toBe(2);
      expect(res.stderr).toMatch(/--since/);
    });

    it('--runner (empty) → exit 2 (a typo must not read as "no runs")', async () => {
      const res = await runCli(['runs', '--runner=', '--admin-url', base]);
      expect(res.code).toBe(2);
      expect(res.stderr).toContain('--runner');
    });
  });

  describe('R3 — bulk cancel/retry', () => {
    it('cancel <id...> full success → exit 0, --json carries ok/failed', async () => {
      fixture.seed({ runs: [run('r1', 'a', { status: 'running' }), run('r3', 'a', { status: 'queued' })] });
      const res = await runCli(['cancel', 'r1', 'r3', '--json', '--admin-url', base]);
      expect(res.code).toBe(0);
      const body = JSON.parse(res.stdout) as { ok: string[]; failed: Array<{ id: string; reason: string }> };
      expect(body.ok.sort()).toEqual(['r1', 'r3']);
      expect(body.failed).toEqual([]);
      expect(fixture.requests().some((r) => r.method === 'POST' && r.path === '/runs/bulk/cancel')).toBe(true);
    });

    it('cancel <id...> partial failure → exit 1, failed carries the reason', async () => {
      fixture.seed({ runs: [run('r1', 'a', { status: 'running' }), run('r2', 'a', { status: 'succeeded' })] });
      const res = await runCli(['cancel', 'r1', 'r2', 'ghost', '--json', '--admin-url', base]);
      expect(res.code).toBe(1);
      const body = JSON.parse(res.stdout) as { ok: string[]; failed: Array<{ id: string; reason: string }> };
      expect(body.ok).toEqual(['r1']);
      expect(body.failed).toEqual([
        { id: 'r2', reason: 'already-terminal' },
        { id: 'ghost', reason: 'not-found' },
      ]);
    });

    it('cancel <id...> partial failure (human output) → exit 1, failed id on stdout', async () => {
      fixture.seed({ runs: [run('r1', 'a', { status: 'running' })] });
      const res = await runCli(['cancel', 'r1', 'ghost', '--admin-url', base]);
      expect(res.code).toBe(1);
      expect(res.stdout).toContain('ghost');
      expect(res.stdout).toContain('not-found');
    });

    it('retry <id...> POSTs the bulk retry endpoint', async () => {
      fixture.seed({ runs: [run('r2', 'a', { status: 'failed', finishedAt: '2026-08-18T09:05:00.000Z' })] });
      const res = await runCli(['retry', 'r2', '--json', '--admin-url', base]);
      expect(res.code).toBe(0);
      const body = JSON.parse(res.stdout) as { ok: string[]; failed: unknown[] };
      expect(body.ok).toEqual(['r2']);
      expect(body.failed).toEqual([]);
      const req = fixture.requests().find((r) => r.method === 'POST');
      expect(req?.path).toBe('/runs/bulk/retry');
    });

    it('cancel without ids → exit 2', async () => {
      const res = await runCli(['cancel', '--admin-url', base]);
      expect(res.code).toBe(2);
      expect(res.stderr).toContain('cancel');
    });
  });

  describe('R2 — status queue line', () => {
    it('active queue: prints `queue: active` (and queue in --json)', async () => {
      fixture.seed({ runs: [] });
      const human = await runCli(['status', '--admin-url', base]);
      expect(human.code).toBe(0);
      expect(human.stdout).toMatch(/^queue: active$/m);

      const json = await runCli(['status', '--json', '--admin-url', base]);
      const body = JSON.parse(json.stdout) as { queue: { paused: boolean; startPaused: boolean } };
      expect(body.queue).toEqual({ paused: false, pausedAt: null, startPaused: false });
    });

    it('paused queue: prints `queue: paused (since …, start-paused)` for a start-pause', async () => {
      fixture.seed({ runs: [], queue: { paused: true, pausedAt: '2026-09-20T20:00:00.000Z', startPaused: true } });
      const res = await runCli(['status', '--admin-url', base]);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('queue: paused (since 2026-09-20 20:00:00Z, start-paused)');
    });

    it('an operator pause omits the start-paused marker', async () => {
      fixture.seed({ runs: [], queue: { paused: true, pausedAt: '2026-09-20T20:00:00.000Z', startPaused: false } });
      const res = await runCli(['status', '--admin-url', base]);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('queue: paused (since 2026-09-20 20:00:00Z)');
      expect(res.stdout).not.toContain('start-paused');
    });

    it('a paused state without pausedAt prints `queue: paused` (no "since —")', async () => {
      fixture.seed({ runs: [], queue: { paused: true, pausedAt: null, startPaused: false } });
      const res = await runCli(['status', '--admin-url', base]);
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/^queue: paused$/m);
      expect(res.stdout).not.toContain('since —');
    });
  });

  it('F7: status --json on an unreachable daemon → JSON error on stdout, exit 1', async () => {
    const dead = 18999; // nothing listens here
    const res = await runCli(['status', '--json', '--admin-url', `http://127.0.0.1:${dead}/api`]);
    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.stdout) as { ok: boolean; error: string; exitCode: number };
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe('string');
    expect(parsed.exitCode).toBe(1);
  });

  it('--help: exit 0, lists subcommands', async () => {
    const res = await runCli(['--help']);
    expect(res.code).toBe(0);
    for (const sub of ['status', 'runs', 'tasks', 'schedules', 'trigger', 'pause', 'resume', 'check-worker']) {
      expect(res.stdout).toContain(sub);
    }
  });

  it('connection refused → exit 1 with a helpful JSON error (F7)', async () => {
    const res = await runCli(['status', '--json', '--admin-url', 'http://127.0.0.1:1']);
    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.stdout) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('admin');
  });

  it('tasks (human): FAILS column sits after PAUSED — the count, and an em dash for zero', async () => {
    fixture.seed({ tasks: [task('red', { failCount: 3 }), task('clean', { failCount: 0 })] });
    const res = await runCli(['tasks', '--admin-url', base]);
    expect(res.code).toBe(0);

    const lines = res.stdout.trimEnd().split('\n');
    // FAILS is the streak-visibility column (R1): after PAUSED, before NEXT RUN.
    expect(lines[0]).toMatch(/^NAME\s+RUNNER\s+PRIORITY\s+PAUSED\s+FAILS\s+NEXT RUN$/);

    const red = lines.find((l) => l.startsWith('red'))!;
    const clean = lines.find((l) => l.startsWith('clean'))!;
    expect(red.split(/\s{2,}/)).toEqual(['red', 'http', '0', 'no', '3', '2026-08-19 09:00:00Z']);
    expect(clean.split(/\s{2,}/)[4]).toBe('—');
  });

  it('tasks (human): FAILS adds the task’s schedule rows — a schedule-driven task’s state lives there', async () => {
    // The bug this pins (R1 follow-up): a cron run advances the SCHEDULE row
    // (`engine.completeScheduleRun` → `storage.completeSchedule`), so the task
    // row stays 0 forever and the column read `—` on exactly the boards it
    // exists for. The printed number is the task’s total failed completions:
    // manual runs (task row) plus every schedule row.
    fixture.seed({
      tasks: [task('cron-task', { failCount: 0 }), task('manual', { failCount: 2 }), task('clean')],
      schedules: [
        schedule('s1', 'cron-task', { failCount: 2 }),
        schedule('s2', 'cron-task', { failCount: 1 }),
        schedule('s3', 'clean', { failCount: 0 }),
      ],
    });
    const res = await runCli(['tasks', '--admin-url', base]);
    expect(res.code).toBe(0);

    const lines = res.stdout.trimEnd().split('\n');
    const fails = (name: string) => lines.find((l) => l.startsWith(name))!.split(/\s{2,}/)[4];
    expect(fails('cron-task')).toBe('3'); // 0 on the task row + 2 + 1 on its schedules
    expect(fails('manual')).toBe('2'); // manual trigger/retry path still counts
    expect(fails('clean')).toBe('—');
  });

  it('tasks (human): FAILS pages /schedules — a board past one page is not silently undercounted', async () => {
    const many = Array.from({ length: 1001 }, (_, i) => schedule(`s${i}`, 'busy', { failCount: 1 }));
    fixture.seed({ tasks: [task('busy', { failCount: 0 })], schedules: many });
    const res = await runCli(['tasks', '--admin-url', base]);
    expect(res.code).toBe(0);

    const row = res.stdout.trimEnd().split('\n').find((l) => l.startsWith('busy'))!;
    expect(row.split(/\s{2,}/)[4]).toBe('1001');
    // the aggregate read the second page instead of trusting a 1000-row first one
    const reads = fixture.requests().filter((r) => r.path.startsWith('/schedules')).map((r) => r.path);
    expect(reads.some((p) => p.includes('offset=0'))).toBe(true);
    expect(reads.some((p) => p.includes('offset=1000'))).toBe(true);
  });

  describe('FAILS column — live schedule path (storage → engine → admin-api → CLI)', () => {
    it('a schedule-driven failure reaches the column (not the em dash)', async () => {
      const db = new DatabaseSync(':memory:');
      const storage = createSqliteStorage(db);
      let clock = new Date('2026-09-20T10:00:00Z');

      const taskRow: TaskRecord = {
        name: 'cron-task',
        runner: 'http',
        schedule: { kind: 'interval', ms: 60_000 },
        tz: 'UTC',
        config: {},
        label: null,
        description: null,
        nextRunAt: new Date('2026-09-20T10:00:00Z'),
        lastRunAt: null,
        lockedAt: null,
        failCount: 0,
        priority: 0,
        retry: null,
        retryCount: 0,
        lastRunId: null,
        paused: false,
        disabled: false,
      };
      await storage.upsertTask(taskRow);
      await storage.createSchedule({
        id: 'cron-task',
        taskName: 'cron-task',
        schedule: { kind: 'interval', ms: 60_000 },
        tz: 'UTC',
        data: null,
        externalId: null,
        dedupKey: null,
        nextRunAt: new Date('2026-09-20T10:00:00Z'),
        lastRunAt: null,
        lockedAt: null,
        failCount: 0,
        priority: 0,
        retry: null,
        retryCount: 0,
        lastRunId: null,
        paused: false,
        disabled: false,
        fileManaged: false,
      });

      // four terminal failures through the schedule path
      const engine = createEngine({
        storage,
        now: () => clock,
        runner: {
          async run() {
            return { status: 'failed', error: 'boom' };
          },
        },
      });
      for (let i = 0; i < 4; i++) {
        await engine.runOnce();
        clock = new Date(clock.getTime() + 61_000);
      }

      // the state really went to the SCHEDULE row, never the task row
      expect((await storage.getTask('cron-task'))!.failCount).toBe(0);
      expect((await storage.getSchedule('cron-task'))!.failCount).toBe(4);

      const api = createAdminApi({ storage, engine: engine as never });
      try {
        const port = await api.listen(0);
        const res = await runCli(['tasks', '--admin-url', `http://127.0.0.1:${port}`]);
        expect(res.code).toBe(0);
        const row = res.stdout.trimEnd().split('\n').find((l) => l.startsWith('cron-task'))!;
        expect(row.split(/\s{2,}/)[4]).toBe('4');
      } finally {
        await api.close();
        db.close();
      }
    });
  });

  it('EPIPE: stdout closed early (| head) → exit 0, no crash', async () => {
    fixture.seed({ tasks: [task('a')] });
    const res = await new Promise<CliResult>((resolve, reject) => {
      const child = spawn(process.execPath, [BIN, 'tasks', '--json', '--admin-url', base], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => {
        stdout += c;
        child.stdout.destroy(); // simulate `| head` closing the pipe early
      });
      child.stderr.on('data', (c) => (stderr += c));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    expect(res.code).toBe(0);
  });
});
