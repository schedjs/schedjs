import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdminApi } from '../src/admin-api.js';
import { createSqliteStorage } from '@schedjs/core';
import type { RunRecord, ScheduleRecord, TaskRecord } from '@schedjs/core';
import { makeSchedule } from '@schedjs/core/storage-contract';

function makeTask(name: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    name,
    runner: 'http',
    schedule: { kind: 'cron', cron: '0 9 * * *' },
    tz: 'UTC',
    config: {},
    label: null,
    description: null,
    nextRunAt: new Date('2026-08-16T09:00:00Z'),
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

function makeRun(id: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    taskName: 'task-a',
    runner: 'http',
    startedAt: new Date('2026-08-16T09:00:00Z'),
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

interface StubEngine {
  triggerCalls: Array<{ name: string; opts?: unknown }>;
  retryCalls: string[];
  retryOpts: Array<unknown>;
  cancelCalls: string[];
  triggerResult: (name: string) => Promise<RunRecord | null>;
  retryResult: (runId: string) => Promise<RunRecord | null>;
  cancelResult: (runId: string) => Promise<RunRecord | null>;
}

const stubEngine = (
  result: (name: string) => Promise<RunRecord | null>,
  retryResult: (runId: string) => Promise<RunRecord | null> = async () => makeRun('r-retry'),
  cancelResult: (runId: string) => Promise<RunRecord | null> = async () => makeRun('r-cancelled', { status: 'cancelled' }),
): StubEngine => ({
  triggerCalls: [],
  retryCalls: [],
  retryOpts: [],
  cancelCalls: [],
  triggerResult: result,
  retryResult,
  cancelResult,
});

async function start(opts: {
  storage: ReturnType<typeof createSqliteStorage>;
  engine?: StubEngine;
  apiKey?: string;
  version?: string;
  now?: () => Date;
}) {
  const engine = opts.engine ?? stubEngine(async () => makeRun('r-trigger'));
  const api = createAdminApi({
    engine: {
      triggerTask: async (name: string, o?: unknown) => {
        engine.triggerCalls.push({ name, opts: o });
        return engine.triggerResult(name);
      },
      retryRun: async (runId: string, o?: unknown) => {
        engine.retryCalls.push(runId);
        engine.retryOpts.push(o);
        return engine.retryResult(runId);
      },
      cancelRun: async (runId: string) => {
        engine.cancelCalls.push(runId);
        return engine.cancelResult(runId);
      },
    } as never,
    storage: opts.storage,
    ...(opts.apiKey ? { auth: { apiKey: opts.apiKey } } : {}),
    ...(opts.version ? { version: opts.version } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const port = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  return {
    engine,
    base,
    close: () => api.close(),
  };
}

describe('admin api', () => {
  const servers: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  const startTracked = async (opts: Parameters<typeof start>[0]) => {
    const s = await start(opts);
    servers.push(s);
    return s;
  };

  const freshStorage = () => createSqliteStorage(new DatabaseSync(':memory:'));

  describe('F&F openapi-client report — auth/health + fail-fast', () => {
    it('F-1: with apiKey set, GET /health stays OPEN (no credentials) while other routes 401', async () => {
      const { base } = await startTracked({ storage: freshStorage(), apiKey: 's3cret' });
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      expect(((await health.json()) as { ok: boolean }).ok).toBe(true);
      for (const path of ['/runs', '/tasks', '/schedules']) {
        const res = await fetch(`${base}${path}`);
        expect(res.status).toBe(401);
      }
    });

    it('F-5: POST /schedules fail-fast on unknown top-level fields — no silent create', async () => {
      const storage = freshStorage();
      await storage.upsertTask(makeTask('a'));
      const { base } = await startTracked({ storage, now: () => new Date('2026-08-16T12:00:00Z') });
      const res = await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskName: 'a', schedule: { interval: '1h' }, dedupKey: 'seller-2' }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('dedupKey');
      expect(await storage.listSchedules()).toHaveLength(0);
    });

    it('F-5: PATCH /schedules/{id} rejects unknown fields and taskName re-target', async () => {
      const storage = freshStorage();
      await storage.upsertTask(makeTask('a'));
      await storage.createSchedule(makeSchedule({ id: 'a', taskName: 'a' }));
      const { base } = await startTracked({ storage, now: () => new Date('2026-08-16T12:00:00Z') });
      const unknown = await fetch(`${base}/schedules/a`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schedule: { cron: '0 9 * * *' }, bogus: 1 }),
      });
      expect(unknown.status).toBe(400);
      expect(((await unknown.json()) as { error: string }).error).toContain('bogus');
      const retarget = await fetch(`${base}/schedules/a`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskName: 'b' }),
      });
      expect(retarget.status).toBe(400);
      expect(((await retarget.json()) as { error: string }).error).toContain('taskName');
    });
  });

  describe('runtime task registration — POST /tasks', () => {
    const NOW = '2026-08-16T12:00:00Z';

    it('creates a task (201) with nextRunAt computed from now; persisted', async () => {
      const storage = freshStorage();
      const { base } = await startTracked({ storage, now: () => new Date(NOW) });
      const res = await fetch(`${base}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'nightly',
          runner: 'http',
          schedules: [{ cron: '0 9 * * *' }],
          config: { url: 'http://worker/nightly' },
        }),
      });
      expect(res.status).toBe(201);
      const task = ((await res.json()) as { task: TaskRecord }).task;
      expect(task.name).toBe('nightly');
      expect(task.schedule).toEqual({ kind: 'cron', cron: '0 9 * * *' });
      expect(task.tz).toBe('UTC');
      expect(Date.parse(task.nextRunAt as unknown as string)).toBe(Date.parse('2026-08-17T09:00:00Z')); // daily cron from 12:00Z → next 09:00Z
      expect(task.paused).toBe(false);
      const stored = await storage.getTask('nightly');
      expect(stored!.name).toBe('nightly');
      expect(stored!.nextRunAt!.getTime()).toBe(Date.parse('2026-08-17T09:00:00Z')); // persisted
    });

    it('upserts an existing task (200), preserving runtime state when the schedule is unchanged', async () => {
      const storage = freshStorage();
      await storage.upsertTask(
        makeTask('nightly', { paused: true, failCount: 3, nextRunAt: new Date('2026-08-16T09:00:00Z') }),
      );
      const { base } = await startTracked({ storage, now: () => new Date(NOW) });
      const res = await fetch(`${base}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'nightly',
          runner: 'http',
          schedules: [{ cron: '0 9 * * *' }],
          config: { url: 'http://worker/v2' },
        }),
      });
      expect(res.status).toBe(200);
      const task = ((await res.json()) as { task: TaskRecord }).task;
      expect(task.config).toEqual({ url: 'http://worker/v2' }); // config updated
      expect(task.paused).toBe(true); // runtime state preserved
      expect(task.failCount).toBe(3);
      expect(Date.parse(task.nextRunAt as unknown as string)).toBe(Date.parse('2026-08-16T09:00:00Z')); // unchanged schedule → nextRunAt kept
    });

    it('recomputes nextRunAt when the upsert changes the schedule', async () => {
      const storage = freshStorage();
      await storage.upsertTask(makeTask('nightly', { nextRunAt: new Date('2026-08-16T09:00:00Z') }));
      const { base } = await startTracked({ storage, now: () => new Date(NOW) });
      const res = await fetch(`${base}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'nightly',
          runner: 'http',
          schedules: [{ interval: 'every 30 minutes' }],
          config: { url: 'http://worker/x' },
        }),
      });
      expect(res.status).toBe(200);
      const task = ((await res.json()) as { task: TaskRecord }).task;
      expect(task.schedule).toEqual({ kind: 'interval', ms: 30 * 60 * 1000 });
      expect(Date.parse(task.nextRunAt as unknown as string)).toBe(Date.parse('2026-08-16T12:30:00Z')); // now + 30 min
    });

    it('400 on a bad config (fail-fast, tasks.json parity)', async () => {
      const { base } = await startTracked({ storage: freshStorage() });
      const res = await fetch(`${base}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'broken', runner: 'http', config: {} }), // http requires config.url
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('config.url is required');
      expect(body.error).not.toContain('tasks.json'); // API context, not file context
    });

    it('400 on a malformed schedule / non-object body / invalid JSON', async () => {
      const { base } = await startTracked({ storage: freshStorage() });
      // two schedule keys
      let res = await fetch(`${base}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'x',
          runner: 'http',
          schedules: [{ cron: '0 9 * * *', interval: '30m' }],
          config: { url: 'u' },
        }),
      });
      expect(res.status).toBe(400);
      // non-object body
      res = await fetch(`${base}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([1, 2]),
      });
      expect(res.status).toBe(400);
      // invalid JSON
      res = await fetch(`${base}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('imperative schedules — POST /schedules', () => {
    const NOW = '2026-08-16T12:00:00Z';

    it('creates a schedule (201) with nextRunAt computed from now; runtime-owned', async () => {
      const storage = freshStorage();
      await storage.upsertTask(makeTask('nightly', { config: { url: 'http://worker/x' } }));
      const { base } = await startTracked({ storage, now: () => new Date(NOW) });
      const res = await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          taskName: 'nightly',
          schedule: { interval: 'every hour', data: { idSeller: 2 } },
        }),
      });
      expect(res.status).toBe(201);
      const sched = ((await res.json()) as { schedule: ScheduleRecord }).schedule;
      expect(sched.taskName).toBe('nightly');
      expect(sched.schedule).toEqual({ kind: 'interval', ms: 60 * 60 * 1000 });
      expect(Date.parse(sched.nextRunAt as unknown as string)).toBe(Date.parse('2026-08-16T13:00:00Z'));
      expect(sched.data).toEqual({ idSeller: 2 });
      expect(sched.fileManaged).toBe(false); // runtime-owned — sync never disables it
      expect(sched.id).toMatch(/^[0-9a-f-]{36}$/); // UUID
      expect(await storage.getSchedule(sched.id)).not.toBeNull();
    });

    it('inherits the task priority when the entry does not override it (F1)', async () => {
      const storage = freshStorage();
      await storage.upsertTask(makeTask('nightly', { priority: 10 }));
      const { base } = await startTracked({ storage, now: () => new Date(NOW) });
      const res = await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskName: 'nightly', schedule: { interval: 'every hour' } }),
      });
      expect(res.status).toBe(201);
      const sched = ((await res.json()) as { schedule: ScheduleRecord }).schedule;
      // effective policy materialized at create (entry ?? task default) — an
      // entry without priority must inherit the task's 10, not a collapsed 0 (F1).
      expect(sched.priority).toBe(10);
    });

    it('PATCH without priority preserves the materialized value (F1)', async () => {
      const storage = freshStorage();
      await storage.upsertTask(makeTask('nightly', { priority: 10 }));
      const { base } = await startTracked({ storage, now: () => new Date(NOW) });
      const created = await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskName: 'nightly', schedule: { interval: 'every hour', priority: 4 } }),
      });
      expect(created.status).toBe(201);
      const sched = ((await created.json()) as { schedule: ScheduleRecord }).schedule;
      expect(sched.priority).toBe(4); // explicit override wins at create

      const patched = await fetch(`${base}/schedules/${sched.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schedule: { cron: '0 9 * * *' } }),
      });
      expect(patched.status).toBe(200);
      const updated = ((await patched.json()) as { schedule: ScheduleRecord }).schedule;
      expect(updated.schedule).toEqual({ kind: 'cron', cron: '0 9 * * *' });
      expect(updated.priority).toBe(4); // untouched field survives the patch (F1)
    });

    it('upserts by dedupKey: a second POST with the same key updates in place (200, id preserved)', async () => {
      const storage = freshStorage();
      await storage.upsertTask(makeTask('nightly'));
      const { base } = await startTracked({ storage, now: () => new Date(NOW) });
      const body = {
        taskName: 'nightly',
        schedule: { interval: 'every hour', dedupKey: 'seller-2', data: { idSeller: 2 } },
      };
      const first = await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(first.status).toBe(201);
      const firstSched = ((await first.json()) as { schedule: ScheduleRecord }).schedule;

      const second = await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...body,
          schedule: { interval: 'every hour', dedupKey: 'seller-2', data: { idSeller: 2, extra: true } },
        }),
      });
      expect(second.status).toBe(200);
      const updated = ((await second.json()) as { schedule: ScheduleRecord }).schedule;
      expect(updated.id).toBe(firstSched.id); // the dedupKey is the stable handle
      expect(updated.data).toEqual({ idSeller: 2, extra: true });
      expect(await storage.listSchedules()).toHaveLength(1); // no duplicate
    });

    it('404 for an unknown task', async () => {
      const { base } = await startTracked({ storage: freshStorage() });
      const res = await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskName: 'nope', schedule: { interval: '1h' } }),
      });
      expect(res.status).toBe(404);
    });

    it('400 on a malformed schedule body or bad tz', async () => {
      const storage = freshStorage();
      await storage.upsertTask(makeTask('nightly'));
      const { base } = await startTracked({ storage });
      // two schedule keys / unknown key
      let res = await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskName: 'nightly', schedule: { cron: '0 9 * * *', interval: '1h' } }),
      });
      expect(res.status).toBe(400);
      res = await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskName: 'nightly', schedule: { bogus: 'x' } }),
      });
      expect(res.status).toBe(400);
      // missing taskName
      res = await fetch(`${base}/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schedule: { interval: '1h' } }),
      });
      expect(res.status).toBe(400);
    });

    it('PATCH /schedules/:id edits rule/data/policy in place, recomputes nextRunAt on rule change, keeps runtime state', async () => {
    const storage = freshStorage();
    await storage.upsertTask(makeTask('a'));
    const sched = await storage.createSchedule(makeSchedule({ id: 'a', taskName: 'a', failCount: 3, paused: false }));
    const { base } = await startTracked({ storage, now: () => new Date('2026-08-16T12:00:00Z') });

    // change the rule: interval → cron, nextRunAt recomputes; runtime state preserved
    const res = await fetch(`${base}/schedules/a`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schedule: { cron: '0 9 * * *', data: { idSeller: 2 } }, tz: 'Europe/Moscow' }),
    });
    expect(res.status).toBe(200);
    const updated = ((await res.json()) as { schedule: ScheduleRecord }).schedule;
    expect(updated.schedule).toEqual({ kind: 'cron', cron: '0 9 * * *' });
    expect(updated.tz).toBe('Europe/Moscow');
    expect(updated.data).toEqual({ idSeller: 2 });
    expect(updated.failCount).toBe(3); // runtime state untouched
    expect(updated.id).toBe('a');
    // 09:00 Moscow = 06:00 UTC, next from 12:00Z → tomorrow 06:00Z
    expect(Date.parse(updated.nextRunAt as unknown as string)).toBe(Date.parse('2026-08-17T06:00:00Z'));

    // tz-only patch recomputes too; data-only patch does not touch the rule
    const tzRes = await fetch(`${base}/schedules/a`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tz: 'Asia/Tokyo' }),
    });
    expect(tzRes.status).toBe(200);
    expect(((await tzRes.json()) as { schedule: ScheduleRecord }).schedule.tz).toBe('Asia/Tokyo');
    expect((await fetch(`${base}/schedules/nope`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tz: 'UTC' }) })).status).toBe(404);
    expect(sched).not.toBeNull();
  });

  it('hoists an inner cron timezone over the task tz when no explicit tz is given (r8 #4 F1)', async () => {
    const storage = freshStorage();
    await storage.upsertTask(makeTask('msk', { tz: 'Europe/Moscow' }));
    const { base } = await startTracked({ storage, now: () => new Date(NOW) });
    const res = await fetch(`${base}/schedules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskName: 'msk', schedule: { cron: '0 9 * * *', timezone: 'Asia/Tokyo' } }),
    });
    expect(res.status).toBe(201);
    const sched = ((await res.json()) as { schedule: ScheduleRecord }).schedule;
    // docs 09.admin-api: "tz defaults to the task's timezone; an inner timezone
    // on cron overrides it" — the entry sets its own, so Asia/Tokyo wins, NOT 400.
    expect(sched.tz).toBe('Asia/Tokyo');
  });

  it('hoists an inner cron timezone even over an explicit API tz (r8 #4 F1)', async () => {
    const storage = freshStorage();
    await storage.upsertTask(makeTask('msk', { tz: 'Europe/Moscow' }));
    const { base } = await startTracked({ storage, now: () => new Date(NOW) });
    const res = await fetch(`${base}/schedules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskName: 'msk', tz: 'UTC', schedule: { cron: '0 9 * * *', timezone: 'Asia/Tokyo' } }),
    });
    expect(res.status).toBe(201);
    const sched = ((await res.json()) as { schedule: ScheduleRecord }).schedule;
    expect(sched.tz).toBe('Asia/Tokyo');
  });

  it('PATCH merges: omitted tenant fields survive a rule-only patch (r8 #4 F3)', async () => {
    const storage = freshStorage();
    await storage.upsertTask(makeTask('a'));
    await storage.createSchedule(
      makeSchedule({
        id: 'a',
        taskName: 'a',
        data: { idSeller: 2 },
        dedupKey: 'seller-2',
        retry: { maxAttempts: 3, backoffMs: 1000 },
      }),
    );
    const { base } = await startTracked({ storage, now: () => new Date(NOW) });
    const res = await fetch(`${base}/schedules/a`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schedule: { cron: '0 9 * * *' } }),
    });
    expect(res.status).toBe(200);
    const updated = ((await res.json()) as { schedule: ScheduleRecord }).schedule;
    expect(updated.schedule).toEqual({ kind: 'cron', cron: '0 9 * * *' });
    // a rule-only patch must NOT silently null the tenant/policy fields
    expect(updated.data).toEqual({ idSeller: 2 });
    expect(updated.dedupKey).toBe('seller-2');
    expect(updated.retry).toEqual({ maxAttempts: 3, backoffMs: 1000 });
  });

  it('PATCH honors explicit null to clear a field, leaving the others intact (r8 #4 F3)', async () => {
    const storage = freshStorage();
    await storage.upsertTask(makeTask('a'));
    await storage.createSchedule(
      makeSchedule({
        id: 'a',
        taskName: 'a',
        data: { idSeller: 2 },
        dedupKey: 'seller-2',
        retry: { maxAttempts: 3, backoffMs: 1000 },
      }),
    );
    const { base } = await startTracked({ storage, now: () => new Date(NOW) });
    const res = await fetch(`${base}/schedules/a`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schedule: { cron: '0 9 * * *', data: null } }),
    });
    expect(res.status).toBe(200);
    const updated = ((await res.json()) as { schedule: ScheduleRecord }).schedule;
    expect(updated.data).toBeNull(); // explicit null clears
    expect(updated.dedupKey).toBe('seller-2'); // untouched survives
    expect(updated.retry).toEqual({ maxAttempts: 3, backoffMs: 1000 });
  });

  it('PATCH updates a present tenant field (r8 #4 F3)', async () => {
    const storage = freshStorage();
    await storage.upsertTask(makeTask('a'));
    await storage.createSchedule(makeSchedule({ id: 'a', taskName: 'a', data: { idSeller: 2 }, dedupKey: 'seller-2' }));
    const { base } = await startTracked({ storage, now: () => new Date(NOW) });
    const res = await fetch(`${base}/schedules/a`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schedule: { cron: '0 9 * * *', dedupKey: 'seller-9' } }),
    });
    expect(res.status).toBe(200);
    const updated = ((await res.json()) as { schedule: ScheduleRecord }).schedule;
    expect(updated.dedupKey).toBe('seller-9');
    expect(updated.data).toEqual({ idSeller: 2 });
  });

  it('POST /tasks/:name/schedule is HARD-CUT (404 pointing to POST /schedules)', async () => {
      const storage = freshStorage();
      await storage.upsertTask(makeTask('nightly'));
      const { base } = await startTracked({ storage });
      const res = await fetch(`${base}/tasks/nightly/schedule`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schedule: { interval: 'every hour' } }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('POST /schedules');
    });
  });

  it('GET /health returns ok + version', async () => {
    const { base } = await startTracked({ storage: freshStorage() });
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/); // core package version
  });

  it('GET /health honours an explicit version (daemon passes its own)', async () => {
    const { base } = await startTracked({ storage: freshStorage(), version: '9.9.9' });
    const body = (await (await fetch(`${base}/health`)).json()) as { version: string };
    expect(body.version).toBe('9.9.9');
  });

  it('GET /runs lists runs newest-first, empty at first', async () => {
    const storage = freshStorage();
    const { base } = await startTracked({ storage });
    let res = await fetch(`${base}/runs`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runs: [] });

    await storage.createRun(makeRun('r1', { startedAt: new Date('2026-08-16T09:00:00Z') }));
    await storage.createRun(makeRun('r2', { startedAt: new Date('2026-08-16T10:00:00Z'), status: 'failed' }));
    res = await fetch(`${base}/runs`);
    expect(((await res.json()) as { runs: RunRecord[] }).runs.map((r: RunRecord) => r.id)).toEqual(['r2', 'r1']);
  });

  it('GET /runs supports task/status/limit/offset filters', async () => {
    const storage = freshStorage();
    const { base } = await startTracked({ storage });
    await storage.createRun(makeRun('r1', { taskName: 'a', status: 'succeeded' }));
    await storage.createRun(makeRun('r2', { taskName: 'a', status: 'failed' }));
    await storage.createRun(makeRun('r3', { taskName: 'b', status: 'succeeded' }));

    const byTask = (await (await fetch(`${base}/runs?task=a`)).json()) as { runs: RunRecord[] };
    expect(byTask.runs.map((r: RunRecord) => r.id).sort()).toEqual(['r1', 'r2']);

    const byStatus = (await (await fetch(`${base}/runs?status=succeeded`)).json()) as { runs: RunRecord[] };
    expect(byStatus.runs.map((r: RunRecord) => r.id).sort()).toEqual(['r1', 'r3']);

    const paged = (await (await fetch(`${base}/runs?limit=1&offset=1`)).json()) as { runs: RunRecord[] };
    expect(paged.runs.map((r: RunRecord) => r.id)).toEqual(['r2']);
  });

  it('GET /tasks supports limit/offset pagination', async () => {
    const storage = freshStorage();
    const { base } = await startTracked({ storage });
    for (let i = 1; i <= 4; i++) {
      await storage.upsertTask(makeTask(`task-${i}`));
    }
    const all = (await (await fetch(`${base}/tasks`)).json()) as { tasks: TaskRecord[] };
    expect(all.tasks.map((t) => t.name)).toEqual(['task-1', 'task-2', 'task-3', 'task-4']);

    const paged = (await (await fetch(`${base}/tasks?limit=2&offset=1`)).json()) as { tasks: TaskRecord[] };
    expect(paged.tasks.map((t) => t.name)).toEqual(['task-2', 'task-3']);
  });

  it('GET /schedules supports limit/offset pagination', async () => {
    const storage = freshStorage();
    const { base } = await startTracked({ storage });
    for (let i = 1; i <= 3; i++) {
      await storage.createSchedule(makeSchedule({ id: `task-${i}`, taskName: `task-${i}` }));
    }
    const paged = (await (await fetch(`${base}/schedules?limit=2&offset=1`)).json()) as {
      schedules: Array<{ id: string }>;
    };
    expect(paged.schedules.map((s) => s.id)).toEqual(['task-2', 'task-3']); // id ASC, skip 1, take 2
  });

  it('GET /runs/:id returns a run; 404 for unknown', async () => {
    const storage = freshStorage();
    const { base } = await startTracked({ storage });
    await storage.createRun(makeRun('r1'));
    const res = await fetch(`${base}/runs/r1`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as RunRecord).id).toBe('r1');

    const missing = await fetch(`${base}/runs/nope`);
    expect(missing.status).toBe(404);
  });

  it('GET /runs/:id?logFromOffset=N returns logChunk + logTotalLength instead of the full log', async () => {
    const storage = freshStorage();
    const log = 'line1\nline2\nline3';
    await storage.createRun(makeRun('r1', { status: 'succeeded', log }));
    const { base } = await startTracked({ storage });

    // without the param — current behaviour, full log
    const full = (await (await fetch(`${base}/runs/r1`)).json()) as { log: string };
    expect(full.log).toBe(log);

    // offset 0 → the whole log as a chunk, total length correct, full log omitted
    const from0 = (await (await fetch(`${base}/runs/r1?logFromOffset=0`)).json()) as {
      log: string | null;
      logChunk: string;
      logTotalLength: number;
    };
    expect(from0.logChunk).toBe(log);
    expect(from0.logTotalLength).toBe(log.length);
    expect(from0.log).toBeNull();

    // offset N → tail from N
    const from6 = (await (await fetch(`${base}/runs/r1?logFromOffset=6`)).json()) as {
      logChunk: string;
      logTotalLength: number;
    };
    expect(from6.logChunk).toBe('line2\nline3');
    expect(from6.logTotalLength).toBe(log.length);

    // offset ≥ length → empty chunk
    const past = (await (await fetch(`${base}/runs/r1?logFromOffset=999`)).json()) as { logChunk: string };
    expect(past.logChunk).toBe('');

    // unknown run → 404 even with the param
    expect((await fetch(`${base}/runs/nope?logFromOffset=0`)).status).toBe(404);
  });

  it('GET /runs/:id?logFromOffset=N on a run with no log returns an empty chunk', async () => {
    const storage = freshStorage();
    await storage.createRun(makeRun('r1', { status: 'succeeded', log: null }));
    const { base } = await startTracked({ storage });
    const body = (await (await fetch(`${base}/runs/r1?logFromOffset=0`)).json()) as {
      logChunk: string;
      logTotalLength: number;
    };
    expect(body.logChunk).toBe('');
    expect(body.logTotalLength).toBe(0);
  });

  it('GET /runs/:id?logFromOffset=N coerces an object log to a string (prod defect 5: migrated runs carry log as an object, not plain string)', async () => {
    const storage = freshStorage();
    await storage.createRun(makeRun('r1', { status: 'succeeded' }));
    // books migrated task_runs.log rows where the column held JSON — the mongo
    // doc has `log` as a BSON object. Simulate by stubbing getRun (sqlite cannot
    // bind an object param; mongo stores it natively). The logFromOffset slice
    // must not TypeError; it serializes the object so the UI can render it.
    const origGet = storage.getRun.bind(storage);
    storage.getRun = async (id) => {
      const run = await origGet(id);
      return run ? ({ ...run, log: { stdout: 'line1\nline2' } } as unknown as RunRecord) : null;
    };
    const { base } = await startTracked({ storage });
    const body = (await (await fetch(`${base}/runs/r1?logFromOffset=0`)).json()) as {
      logChunk: string;
      logTotalLength: number;
    };
    expect(body.logChunk).toBe(JSON.stringify({ stdout: 'line1\nline2' }));
    expect(body.logTotalLength).toBe(JSON.stringify({ stdout: 'line1\nline2' }).length);
  });

  it('DELETE /runs/:id removes a run (204); 404 for unknown', async () => {
    const storage = freshStorage();
    const { base } = await startTracked({ storage });
    await storage.createRun(makeRun('r1', { status: 'succeeded', finishedAt: new Date('2026-08-16T09:05:00Z') }));
    const del = await fetch(`${base}/runs/r1`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect(await storage.getRun('r1')).toBeNull();

    const missing = await fetch(`${base}/runs/r1`, { method: 'DELETE' });
    expect(missing.status).toBe(404);
  });

  it('DELETE /runs/:id refuses an active run (409) — cancel first, like books', async () => {
    const storage = freshStorage();
    const { base } = await startTracked({ storage });
    await storage.createRun(makeRun('r1', { status: 'running' }));
    await storage.createRun(makeRun('r2', { status: 'queued' }));
    const res = await fetch(`${base}/runs/r1`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('cancel it first');
    expect((await fetch(`${base}/runs/r2`, { method: 'DELETE' })).status).toBe(409);
    // a finished run still deletes fine
    await storage.createRun(makeRun('r3', { status: 'failed', finishedAt: new Date('2026-08-16T09:05:00Z') }));
    expect((await fetch(`${base}/runs/r3`, { method: 'DELETE' })).status).toBe(204);
  });

  it('POST /runs/:id/cancel cancels an active run via engine.cancelRun (200); 404 unknown', async () => {
    const storage = freshStorage();
    await storage.createRun(makeRun('r1', { status: 'running' }));
    const engine = stubEngine(async () => makeRun('r-trigger'));
    const { base } = await startTracked({ storage, engine });

    const res = await fetch(`${base}/runs/r1/cancel`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(engine.cancelCalls).toEqual(['r1']);
    const body = (await res.json()) as { run: RunRecord };
    expect(body.run.status).toBe('cancelled');

    const missing = await fetch(`${base}/runs/nope/cancel`, { method: 'POST' });
    expect(missing.status).toBe(404);
  });

  it('POST /runs/:id/cancel refuses a terminal run (409) and wrong methods (405)', async () => {
    const storage = freshStorage();
    const engine = stubEngine(async () => makeRun('r-trigger'));
    const { base } = await startTracked({ storage, engine });
    await storage.createRun(makeRun('r1', { status: 'succeeded', finishedAt: new Date('2026-08-16T09:05:00Z') }));
    await storage.createRun(makeRun('r2', { status: 'cancelled', finishedAt: new Date('2026-08-16T09:05:00Z') }));
    expect((await fetch(`${base}/runs/r1/cancel`, { method: 'POST' })).status).toBe(409);
    expect((await fetch(`${base}/runs/r2/cancel`, { method: 'POST' })).status).toBe(409);
    expect(engine.cancelCalls).toEqual([]); // engine never consulted
    expect((await fetch(`${base}/runs/r1/cancel`, { method: 'GET' })).status).toBe(405);
  });

  it('POST /runs/:id/retry re-runs a run via engine.retryRun and returns it', async () => {
    const storage = freshStorage();
    await storage.createRun(makeRun('r1', { status: 'failed', taskName: 'task-a' }));
    const engine = stubEngine(async () => makeRun('r-trigger'), async () => makeRun('r-retry', { retryOf: 'r1', trigger: 'manual' }));
    const { base } = await startTracked({ storage, engine });

    const res = await fetch(`${base}/runs/r1/retry`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: RunRecord };
    expect(body.run.id).toBe('r-retry');
    expect(body.run.retryOf).toBe('r1');
    expect(engine.retryCalls).toEqual(['r1']);
  });

  it('POST /runs/:id/retry 404s on an unknown run; 409 when the task is gone', async () => {
    const storage = freshStorage();
    await storage.createRun(makeRun('r1', { status: 'failed' }));
    const engine = stubEngine(async () => makeRun('r-trigger'), async () => null); // task gone → engine null
    const { base } = await startTracked({ storage, engine });

    expect((await fetch(`${base}/runs/nope/retry`, { method: 'POST' })).status).toBe(404);
    const conflict = await fetch(`${base}/runs/r1/retry`, { method: 'POST' });
    expect(conflict.status).toBe(409);
    expect((await fetch(`${base}/runs/r1/retry`)).status).toBe(405); // GET not allowed
  });

  it('POST /runs/:id/retry forwards triggeredBy from the optional JSON body (fresh actor — who retries now)', async () => {
    const storage = freshStorage();
    await storage.createRun(makeRun('r1', { status: 'failed', taskName: 'task-a' }));
    const engine = stubEngine(async () => makeRun('r-trigger'), async () => makeRun('r-retry', { retryOf: 'r1', trigger: 'manual' }));
    const { base } = await startTracked({ storage, engine });

    const res = await fetch(`${base}/runs/r1/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ triggeredBy: 'boss@books' }),
    });
    expect(res.status).toBe(200);
    expect(engine.retryCalls).toEqual(['r1']);
    expect(engine.retryOpts).toEqual([{ triggeredBy: 'boss@books' }]);

    // explicit null = anonymous (same as no body)
    await fetch(`${base}/runs/r1/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ triggeredBy: null }),
    });
    expect(engine.retryOpts[1]).toEqual({ triggeredBy: null });
  });

  it('POST /runs/:id/retry rejects a malformed body or non-string triggeredBy with 400', async () => {
    const storage = freshStorage();
    await storage.createRun(makeRun('r1', { status: 'failed', taskName: 'task-a' }));
    const { base } = await startTracked({ storage });

    expect((await fetch(`${base}/runs/r1/retry`, { method: 'POST', body: '{not json' })).status).toBe(400);
    expect(
      (await fetch(`${base}/runs/r1/retry`, { method: 'POST', body: JSON.stringify({ triggeredBy: 42 }) })).status,
    ).toBe(400);
    expect(
      (await fetch(`${base}/runs/r1/retry`, { method: 'POST', body: JSON.stringify([1, 2]) })).status,
    ).toBe(400);
  });

  it('GET /tasks lists tasks; GET /tasks/:name returns one; 404 for unknown', async () => {
    const storage = freshStorage();
    const { base } = await startTracked({ storage });
    await storage.upsertTask(makeTask('a'));
    await storage.upsertTask(makeTask('b', { paused: true }));

    const list = (await (await fetch(`${base}/tasks`)).json()) as { tasks: TaskRecord[] };
    expect(list.tasks.map((t: TaskRecord) => t.name)).toEqual(['a', 'b']);

    const one = await fetch(`${base}/tasks/a`);
    expect(one.status).toBe(200);
    expect(((await one.json()) as TaskRecord).name).toBe('a');

    expect((await fetch(`${base}/tasks/nope`)).status).toBe(404);
  });

  it('POST /tasks/:name/run triggers the engine and returns the run; 404 for unknown', async () => {
    const storage = freshStorage();
    await storage.upsertTask(makeTask('a'));
    const engine = stubEngine(async (name) => (name === 'a' ? makeRun('r-trigger') : null));
    const { base } = await startTracked({ storage, engine });

    const res = await fetch(`${base}/tasks/a/run`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { run: RunRecord }).run.id).toBe('r-trigger');
    expect(engine.triggerCalls).toEqual([{ name: 'a', opts: undefined }]);

    expect((await fetch(`${base}/tasks/nope/run`, { method: 'POST' })).status).toBe(404);
  });

  it('POST /tasks/:name/run forwards temporary/data from the optional JSON body (24h retention class via API)', async () => {
    const storage = freshStorage();
    await storage.upsertTask(makeTask('a'));
    const engine = stubEngine(async () => makeRun('r-trigger'));
    const { base } = await startTracked({ storage, engine });

    const res = await fetch(`${base}/tasks/a/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ temporary: true, data: { idPickingList: 7 } }),
    });
    expect(res.status).toBe(200);
    expect(engine.triggerCalls).toEqual([{ name: 'a', opts: { temporary: true, data: { idPickingList: 7 } } }]);

    // no body → no options (backward compatible)
    await fetch(`${base}/tasks/a/run`, { method: 'POST' });
    expect(engine.triggerCalls[1]!.opts).toBeUndefined();
  });

  it('POST /tasks/:name/run forwards triggeredBy from the optional JSON body (caller-supplied audit identity)', async () => {
    const storage = freshStorage();
    await storage.upsertTask(makeTask('a'));
    const engine = stubEngine(async () => makeRun('r-trigger'));
    const { base } = await startTracked({ storage, engine });

    const res = await fetch(`${base}/tasks/a/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ triggeredBy: 'boss@books', temporary: true }),
    });
    expect(res.status).toBe(200);
    expect(engine.triggerCalls).toEqual([{ name: 'a', opts: { triggeredBy: 'boss@books', temporary: true } }]);

    // explicit null = anonymous
    await fetch(`${base}/tasks/a/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ triggeredBy: null }),
    });
    expect(engine.triggerCalls[1]!.opts).toEqual({ triggeredBy: null });
  });

  it('POST /tasks/:name/run rejects a malformed or non-object body with 400', async () => {
    const storage = freshStorage();
    await storage.upsertTask(makeTask('a'));
    const { base } = await startTracked({ storage });

    expect(
      (await fetch(`${base}/tasks/a/run`, { method: 'POST', body: '{not json' })).status,
    ).toBe(400);
    expect(
      (await fetch(`${base}/tasks/a/run`, { method: 'POST', body: JSON.stringify({ temporary: 'yes' }) })).status,
    ).toBe(400);
    expect(
      (await fetch(`${base}/tasks/a/run`, { method: 'POST', body: JSON.stringify({ triggeredBy: 42 }) })).status,
    ).toBe(400);
    expect(
      (await fetch(`${base}/tasks/a/run`, { method: 'POST', body: JSON.stringify([1, 2]) })).status,
    ).toBe(400);
  });

  it('POST /tasks/:name/pause and /resume flip the flag; 404 for unknown', async () => {
    const storage = freshStorage();
    const { base } = await startTracked({ storage });
    await storage.upsertTask(makeTask('a'));

    const pause = await fetch(`${base}/tasks/a/pause`, { method: 'POST' });
    expect(pause.status).toBe(200);
    expect((await storage.getTask('a'))!.paused).toBe(true);

    const resume = await fetch(`${base}/tasks/a/resume`, { method: 'POST' });
    expect(resume.status).toBe(200);
    expect((await storage.getTask('a'))!.paused).toBe(false);

    expect((await fetch(`${base}/tasks/nope/pause`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${base}/tasks/nope/resume`, { method: 'POST' })).status).toBe(404);
  });

  it('GET /schedules lists schedule-as-entity rows with effective status', async () => {
    const storage = freshStorage();
    await storage.upsertTask(makeTask('a'));
    await storage.createSchedule(makeSchedule({ id: 'a', taskName: 'a' }));
    const { base } = await startTracked({ storage });
    const res = await fetch(`${base}/schedules`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { schedules: Array<{ id: string; taskName: string; schedule: unknown; effectiveStatus: string }> };
    expect(body.schedules).toHaveLength(1);
    expect(body.schedules[0]!.id).toBe('a');
    expect(body.schedules[0]!.taskName).toBe('a');
    expect(body.schedules[0]!.schedule).toEqual({ kind: 'cron', cron: '0 9 * * *' });
    expect(body.schedules[0]!.effectiveStatus).toBe('active');
  });

  it('GET /schedules resolves lastRunId + lastRunStatus + effectiveStatus in one pass (no N+1)', async () => {
    const storage = freshStorage();
    await storage.upsertTask(makeTask('a', { lastRunId: 'run-1' }));
    await storage.createSchedule(makeSchedule({ id: 'a', taskName: 'a', lastRunId: 'run-1' }));
    await storage.createRun(
      makeRun('run-1', { taskName: 'a', status: 'failed', finishedAt: new Date('2026-08-16T09:05:00Z'), error: 'boom' }),
    );
    await storage.upsertTask(makeTask('b')); // no runs yet
    await storage.createSchedule(makeSchedule({ id: 'b', taskName: 'b' }));
    const { base } = await startTracked({ storage });

    const res = await fetch(`${base}/schedules`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      schedules: Array<{ id: string; lastRunId: string | null; lastRunStatus: string | null; effectiveStatus: string }>;
    };
    const byId = Object.fromEntries(body.schedules.map((s) => [s.id, s]));
    expect(byId['a']!.lastRunId).toBe('run-1');
    expect(byId['a']!.lastRunStatus).toBe('failed');
    expect(byId['b']!.lastRunId).toBeNull();
    expect(byId['b']!.lastRunStatus).toBeNull();
  });

  it('effective status reflects pause AND: paused-task and paused-schedule are distinguishable', async () => {
    const storage = freshStorage();
    await storage.upsertTask(makeTask('a', { paused: true }));
    await storage.createSchedule(makeSchedule({ id: 'a', taskName: 'a' }));
    await storage.upsertTask(makeTask('b'));
    await storage.createSchedule(makeSchedule({ id: 'b', taskName: 'b', paused: true }));
    const { base } = await startTracked({ storage });

    const body = (await (await fetch(`${base}/schedules`)).json()) as {
      schedules: Array<{ id: string; effectiveStatus: string }>;
    };
    const byId = Object.fromEntries(body.schedules.map((s) => [s.id, s]));
    expect(byId['a']!.effectiveStatus).toBe('paused-task');
    expect(byId['b']!.effectiveStatus).toBe('paused-schedule');
  });

  it('GET /schedules/:id, DELETE /schedules/:id, and pause/resume per schedule', async () => {
    const storage = freshStorage();
    await storage.upsertTask(makeTask('a'));
    const sched = await storage.createSchedule(makeSchedule({ id: 'a', taskName: 'a' }));
    const { base } = await startTracked({ storage });

    // GET one
    const got = await fetch(`${base}/schedules/a`);
    expect(got.status).toBe(200);
    const one = (await got.json()) as { id: string; effectiveStatus: string };
    expect(one.id).toBe('a');
    expect((await fetch(`${base}/schedules/nope`)).status).toBe(404);

    // pause / resume — AND semantics: schedule-level flag only
    expect((await fetch(`${base}/schedules/a/pause`, { method: 'POST' })).status).toBe(200);
    expect((await storage.getSchedule('a'))!.paused).toBe(true);
    expect((await storage.getTask('a'))!.paused).toBe(false); // task level untouched
    expect((await fetch(`${base}/schedules/a/resume`, { method: 'POST' })).status).toBe(200);
    expect((await storage.getSchedule('a'))!.paused).toBe(false);
    expect((await fetch(`${base}/schedules/nope/pause`, { method: 'POST' })).status).toBe(404);

    // DELETE removes the schedule; runs keep their history
    await storage.createRun(makeRun('r1', { taskName: 'a', scheduleId: 'a' }));
    expect((await fetch(`${base}/schedules/a`, { method: 'DELETE' })).status).toBe(204);
    expect(await storage.getSchedule('a')).toBeNull();
    expect(await storage.getRun('r1')).not.toBeNull(); // audit survives
    expect((await fetch(`${base}/schedules/a`, { method: 'DELETE' })).status).toBe(404);
    expect(sched).not.toBeNull();
  });

  it('GET /tasks items carry lastRunStatus (r6 F10)', async () => {
    const storage = freshStorage();
    await storage.upsertTask(makeTask('a', { lastRunId: 'run-1' }));
    await storage.createRun(
      makeRun('run-1', { taskName: 'a', status: 'succeeded', finishedAt: new Date('2026-08-16T09:05:00Z') }),
    );
    const { base } = await startTracked({ storage });

    const body = (await (await fetch(`${base}/tasks`)).json()) as {
      tasks: Array<TaskRecord & { lastRunStatus: string | null }>;
    };
    expect(body.tasks[0]!.lastRunStatus).toBe('succeeded');
  });

  it('POST /tasks registers a runtime task (fileManaged=false) — survives sync (r7 F1)', async () => {
    const storage = freshStorage();
    const { base } = await startTracked({ storage });
    const res = await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'runtime', runner: 'http', schedules: [{ interval: 'every 1 minute' }], config: { url: 'http://w' } }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { task: TaskRecord };
    expect(body.task.fileManaged).toBe(false);
  });

  it('DELETE /tasks/:name removes a task (204), unknown → 404 (r7 F1 companion)', async () => {
    const storage = freshStorage();
    await storage.upsertTask(makeTask('a'));
    const { base } = await startTracked({ storage });

    expect((await fetch(`${base}/tasks/a`, { method: 'DELETE' })).status).toBe(204);
    expect(await storage.getTask('a')).toBeNull();
    expect((await fetch(`${base}/tasks/a`, { method: 'DELETE' })).status).toBe(404);
  });

  it('rejects unknown paths with 404 and wrong methods with 405', async () => {
    const { base } = await startTracked({ storage: freshStorage() });
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/tasks`, { method: 'DELETE' })).status).toBe(405); // DELETE /tasks: unsupported
    expect((await fetch(`${base}/runs/r1`, { method: 'PUT' })).status).toBe(405); // PUT /runs/:id: unsupported
    expect((await fetch(`${base}/tasks/nightly/schedule`, { method: 'GET' })).status).toBe(405);
  });

  it('requires Bearer auth when apiKey is set; 401 without/wrong, 200 with', async () => {
    const storage = freshStorage();
    await storage.upsertTask(makeTask('a'));
    const { base } = await startTracked({ storage, apiKey: 'secret-1' });

    expect((await fetch(`${base}/tasks`)).status).toBe(401);
    expect((await fetch(`${base}/tasks`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    const ok = await fetch(`${base}/tasks`, { headers: { Authorization: 'Bearer secret-1' } });
    expect(ok.status).toBe(200);
  });
});

describe('admin api — artifact proxy', () => {
  const freshStorage = () => createSqliteStorage(new DatabaseSync(':memory:'));

  async function startWithReader(opts: { storage: ReturnType<typeof createSqliteStorage>; apiKey?: string }) {
    const reader = {
      calls: [] as string[],
      get: async (ref: string) => {
        reader.calls.push(ref);
        if (ref === 's3://bucket/missing.md') return null;
        return { contentType: 'text/markdown; charset=utf-8', body: Buffer.from('# report\ncontent') };
      },
    };
    const api = createAdminApi({
      engine: stubEngine(async () => makeRun('r-trigger')) as never,
      storage: opts.storage,
      artifactsReader: reader,
      ...(opts.apiKey ? { auth: { apiKey: opts.apiKey } } : {}),
    });
    const port = await api.listen(0);
    return { reader, base: `http://127.0.0.1:${port}`, close: () => api.close() };
  }

  it('streams an artifact by index with the reader content-type', async () => {
    const storage = freshStorage();
    await storage.createRun(makeRun('r-art', {
      status: 'succeeded',
      artifacts: [{ kind: 's3', ref: 's3://bucket/reports/r-art.md', label: 'Report' }],
    }));
    const { reader, base, close } = await startWithReader({ storage });

    const res = await fetch(`${base}/runs/r-art/artifacts/0`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(await res.text()).toContain('# report');
    expect(reader.calls).toEqual(['s3://bucket/reports/r-art.md']);
    await close();
  });

  it('404s on unknown run, bad index, and missing object', async () => {
    const storage = freshStorage();
    await storage.createRun(makeRun('r-art', {
      status: 'succeeded',
      artifacts: [{ kind: 's3', ref: 's3://bucket/missing.md', label: 'Report' }],
    }));
    const { base, close } = await startWithReader({ storage });

    expect((await fetch(`${base}/runs/nope/artifacts/0`)).status).toBe(404);
    expect((await fetch(`${base}/runs/r-art/artifacts/5`)).status).toBe(404);
    expect((await fetch(`${base}/runs/r-art/artifacts/0`)).status).toBe(404); // reader → null
    await close();
  });

  it('rejects non-s3 refs (url/file/email are direct links, not proxied)', async () => {
    const storage = freshStorage();
    await storage.createRun(makeRun('r-url', {
      status: 'succeeded',
      artifacts: [{ kind: 'url', ref: 'https://example.com/x', label: 'X' }],
    }));
    const { base, close } = await startWithReader({ storage });

    expect((await fetch(`${base}/runs/r-url/artifacts/0`)).status).toBe(400);
    await close();
  });
});
