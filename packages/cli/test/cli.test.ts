import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
