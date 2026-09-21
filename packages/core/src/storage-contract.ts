import type { beforeEach, describe, expect, it } from 'vitest';
import type { CompleteResult, Storage } from './storage.js';
import type { ArtifactRef, RunRecord, ScheduleRecord, TaskRecord } from './types.js';

/**
 * The vitest surface the contract suite needs. Injected by the caller (their
 * own vitest) instead of imported here — so the published `storage-contract`
 * subpath has zero runtime dependencies and any adapter author can run it with
 * the test runner they already have.
 */
export interface ContractTestApi {
  describe: typeof describe;
  it: typeof it;
  expect: typeof expect;
  beforeEach: typeof beforeEach;
}

export function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    name: 'task-a',
    runner: 'http',
    schedule: { kind: 'cron', cron: '0 9 * * *' },
    tz: 'UTC',
    config: {},
    // contract default: no inputSchema (any data is accepted)
    inputSchema: null,
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
    timeoutMs: null,
    paused: false,
    disabled: false,
    // contract default: tasks are file-managed (runtime POST /tasks sets false)
    fileManaged: true,
    ...overrides,
  };
}

/**
 * Contract default: tasks are file-managed (runtime POST /tasks sets false)
 */
export function makeSchedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: 'sched-1',
    taskName: 'task-a',
    schedule: { kind: 'cron', cron: '0 9 * * *' },
    tz: 'UTC',
    data: null,
    externalId: null,
    dedupKey: null,
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
    // contract default: file-managed (runtime POST /schedules sets false)
    fileManaged: true,
    ...overrides,
  };
}

const completed: CompleteResult = {
  nextRunAt: new Date('2026-08-17T09:00:00Z'),
  lastRunAt: new Date('2026-08-16T09:05:00Z'),
  failed: false,
};

/**
 * Shared contract for every Storage adapter. New adapters (MariaDB, Postgres,
 * in-memory) must pass this suite unchanged — pins the seam the engine relies on.
 *
 * Pass your own vitest API in the first argument:
 *
 * ```ts
 * import { describe, it, expect, beforeEach } from 'vitest';
 * import { storageContractTests } from '@schedjs/core/storage-contract';
 * storageContractTests({ describe, it, expect, beforeEach }, 'my-custom', make);
 * ```
 */
export function storageContractTests(api: ContractTestApi, name: string, make: () => Storage): void {
  const { describe, it, expect, beforeEach } = api;
  describe(`storage contract — ${name}`, () => {
    let s: Storage;
    beforeEach(() => {
      s = make();
    });

    describe('tasks CRUD', () => {
      it('round-trips a task through upsert → get', async () => {
        await s.upsertTask(makeTask());
        expect(await s.getTask('task-a')).toEqual(makeTask());
      });

      it('returns null for a missing task', async () => {
        expect(await s.getTask('nope')).toBeNull();
      });

      it('upsert overwrites an existing task (no duplicates)', async () => {
        await s.upsertTask(makeTask());
        await s.upsertTask(makeTask({ tz: 'Europe/Moscow', failCount: 2 }));
        const all = await s.listTasks();
        expect(all).toHaveLength(1);
        expect(all[0]!.tz).toBe('Europe/Moscow');
        expect(all[0]!.failCount).toBe(2);
      });

      it('listTasks applies limit and offset (name ASC)', async () => {
        for (let i = 1; i <= 5; i++) {
          await s.upsertTask(makeTask({ name: `task-${i}` }));
        }
        const page = await s.listTasks({ limit: 2, offset: 1 });
        expect(page.map((t) => t.name)).toEqual(['task-2', 'task-3']); // name ASC, skip 1, take 2
      });

      it('preserves runner config through upsert → get', async () => {
        await s.upsertTask(
          makeTask({ config: { url: 'http://worker:3000/tasks/sync', method: 'POST', timeoutMs: 5000 } }),
        );
        const t = await s.getTask('task-a');
        expect(t!.config).toEqual({ url: 'http://worker:3000/tasks/sync', method: 'POST', timeoutMs: 5000 });
      });

      it('deleteTask removes a task', async () => {
        await s.upsertTask(makeTask());
        await s.deleteTask('task-a');
        expect(await s.getTask('task-a')).toBeNull();
      });
    });

    describe('due selection', () => {
      const now = new Date('2026-08-16T10:00:00Z');

      it('selects due, unlocked, unpaused, enabled tasks ordered by nextRunAt', async () => {
        await s.upsertTask(makeTask({ name: 'b', nextRunAt: new Date('2026-08-16T09:45:00Z') }));
        await s.upsertTask(makeTask({ name: 'a', nextRunAt: new Date('2026-08-16T09:30:00Z') }));
        await s.upsertTask(makeTask({ name: 'future', nextRunAt: new Date('2026-08-17T00:00:00Z') }));
        const due = await s.listDueTasks(now);
        expect(due.map((t) => t.name)).toEqual(['a', 'b']);
      });

      it('orders by priority DESC first, then nextRunAt ASC', async () => {
        await s.upsertTask(makeTask({ name: 'urgent', priority: 10, nextRunAt: new Date('2026-08-16T09:59:00Z') }));
        await s.upsertTask(makeTask({ name: 'normal', priority: 0, nextRunAt: new Date('2026-08-16T09:00:00Z') }));
        await s.upsertTask(makeTask({ name: 'high', priority: 5, nextRunAt: new Date('2026-08-16T09:30:00Z') }));
        const due = await s.listDueTasks(now);
        expect(due.map((t) => t.name)).toEqual(['urgent', 'high', 'normal']);
      });

      it('excludes locked, paused, disabled, and null-nextRunAt tasks', async () => {
        await s.upsertTask(makeTask({ name: 'locked', lockedAt: new Date('2026-08-16T09:00:00Z') }));
        await s.upsertTask(makeTask({ name: 'paused', paused: true }));
        await s.upsertTask(makeTask({ name: 'disabled', disabled: true }));
        await s.upsertTask(makeTask({ name: 'done', nextRunAt: null }));
        const due = await s.listDueTasks(now);
        expect(due).toHaveLength(0);
      });
    });

    describe('claiming', () => {
      it('claims a free task exactly once (atomic)', async () => {
        await s.upsertTask(makeTask());
        expect(await s.claimTask('task-a', new Date('2026-08-16T09:00:00Z'))).toBe(true);
        expect(await s.claimTask('task-a', new Date('2026-08-16T09:00:01Z'))).toBe(false);
      });

      it('refuses to claim a paused or disabled task', async () => {
        await s.upsertTask(makeTask({ paused: true }));
        expect(await s.claimTask('task-a', new Date('2026-08-16T09:00:00Z'))).toBe(false);
        await s.upsertTask(makeTask({ disabled: true }));
        expect(await s.claimTask('task-a', new Date('2026-08-16T09:00:00Z'))).toBe(false);
      });

      it('records the lock timestamp', async () => {
        await s.upsertTask(makeTask());
        const at = new Date('2026-08-16T09:00:00Z');
        await s.claimTask('task-a', at);
        expect((await s.getTask('task-a'))!.lockedAt).toEqual(at);
      });
    });

    describe('completion', () => {
      it('clears the lock and advances next/last run', async () => {
        await s.upsertTask(makeTask({ lockedAt: new Date('2026-08-16T09:00:00Z') }));
        await s.completeTask('task-a', completed);
        const t = await s.getTask('task-a');
        expect(t!.lockedAt).toBeNull();
        expect(t!.nextRunAt).toEqual(completed.nextRunAt);
        expect(t!.lastRunAt).toEqual(completed.lastRunAt);
        expect(t!.failCount).toBe(0);
      });

      it('increments failCount when the run failed', async () => {
        await s.upsertTask(makeTask({ lockedAt: new Date('2026-08-16T09:00:00Z') }));
        await s.completeTask('task-a', { ...completed, failed: true });
        expect((await s.getTask('task-a'))!.failCount).toBe(1);
      });

      it('persists the retryCount passed in the result (absolute, not incremental)', async () => {
        await s.upsertTask(makeTask({ lockedAt: new Date('2026-08-16T09:00:00Z'), retryCount: 1 }));
        await s.completeTask('task-a', { ...completed, retryCount: 3 });
        expect((await s.getTask('task-a'))!.retryCount).toBe(3);
        await s.completeTask('task-a', { ...completed, retryCount: 0 });
        expect((await s.getTask('task-a'))!.retryCount).toBe(0);
      });
    });

    describe('zombie reaping', () => {
      it('unlocks stale locks and bumps failCount; leaves fresh locks alone', async () => {
        const olderThan = new Date('2026-08-16T09:00:00Z');
        await s.upsertTask(makeTask({ name: 'stale', lockedAt: new Date('2026-08-16T08:00:00Z') }));
        await s.upsertTask(makeTask({ name: 'fresh', lockedAt: new Date('2026-08-16T09:05:00Z') }));
        await s.upsertTask(makeTask({ name: 'free' }));
        expect(await s.reapZombieLocks(olderThan)).toBe(1);
        const stale = await s.getTask('stale');
        expect(stale!.lockedAt).toBeNull();
        expect(stale!.failCount).toBe(1);
        expect((await s.getTask('fresh'))!.lockedAt).not.toBeNull();
      });
    });

    describe('lock heartbeat (refreshLock)', () => {
      it('extends lockedAt on a claimed task, leaving schedule/state fields untouched', async () => {
        await s.upsertTask(makeTask({ lockedAt: new Date('2026-08-16T09:00:00Z') }));
        await s.refreshLock('task-a', new Date('2026-08-16T10:30:00Z'));
        const t = await s.getTask('task-a');
        expect(t!.lockedAt).toEqual(new Date('2026-08-16T10:30:00Z'));
        expect(t!.nextRunAt).toEqual(makeTask().nextRunAt); // schedule untouched
        expect(t!.failCount).toBe(0); // failCount is reap's job, never the heartbeat's
      });

      it('is a no-op for an unlocked task (never locks it)', async () => {
        await s.upsertTask(makeTask());
        await s.refreshLock('task-a', new Date('2026-08-16T10:30:00Z'));
        expect((await s.getTask('task-a'))!.lockedAt).toBeNull();
      });

      it('is a no-op for an unknown task', async () => {
        await expect(s.refreshLock('nope', new Date('2026-08-16T10:30:00Z'))).resolves.toBeUndefined();
      });
    });

    describe('startup recovery (clearLocks)', () => {
      it('releases every lock without touching other state', async () => {
        await s.upsertTask(makeTask({ name: 'a', lockedAt: new Date('2026-08-16T09:00:00Z') }));
        await s.upsertTask(makeTask({ name: 'b', lockedAt: new Date('2026-08-16T10:00:00Z') }));
        await s.upsertTask(makeTask({ name: 'free' }));
        expect(await s.clearLocks()).toBe(2);
        expect((await s.getTask('a'))!.lockedAt).toBeNull();
        expect((await s.getTask('b'))!.lockedAt).toBeNull();
        expect((await s.getTask('free'))!.lockedAt).toBeNull(); // already unlocked
        expect((await s.getTask('a'))!.failCount).toBe(0); // not reap — no failCount bump
        expect((await s.getTask('a'))!.nextRunAt).toEqual(makeTask().nextRunAt); // schedule untouched
      });
    });

    describe('schedules CRUD (schedule-as-entity, slice 1)', () => {
      it('round-trips a schedule with all fields (data/externalId/dedupKey/policy/runtime state)', async () => {
        const sched = makeSchedule({
          data: { idSeller: 2 },
          externalId: 'tenant-7',
          dedupKey: 'seller-2',
          retry: { maxAttempts: 3, backoffMs: 60_000 },
          priority: 5,
          nextRunAt: new Date('2026-08-17T09:00:00Z'),
          lastRunAt: new Date('2026-08-16T09:05:00Z'),
          failCount: 1,
          retryCount: 2,
          lastRunId: 'r9',
        });
        await s.createSchedule(sched);
        expect(await s.getSchedule('sched-1')).toEqual(sched);
      });

      it('dedupKey upsert: second create with the same key updates the row (id preserved, no duplicate)', async () => {
        await s.createSchedule(makeSchedule({ id: 's1', dedupKey: 'seller-2', data: { idSeller: 2 } }));
        const stored = await s.createSchedule(
          makeSchedule({ id: 's2', dedupKey: 'seller-2', data: { idSeller: 2, extra: true } }),
        );
        // the dedupKey is the stable handle — the existing row is updated, its id survives
        expect(stored.id).toBe('s1');
        const all = await s.listSchedules();
        expect(all).toHaveLength(1);
        expect(all[0]!.id).toBe('s1');
        expect(all[0]!.data).toEqual({ idSeller: 2, extra: true });
      });

      it('listSchedules filters by taskName, paginates, orders by id ASC; deleteSchedule removes', async () => {
        await s.createSchedule(makeSchedule({ id: 'b', taskName: 'task-b' }));
        await s.createSchedule(makeSchedule({ id: 'a', taskName: 'task-a' }));
        await s.createSchedule(makeSchedule({ id: 'c', taskName: 'task-a' }));
        const forA = await s.listSchedules({ taskName: 'task-a' });
        expect(forA.map((x) => x.id)).toEqual(['a', 'c']); // id ASC
        const page = await s.listSchedules({ taskName: 'task-a', limit: 1, offset: 1 });
        expect(page.map((x) => x.id)).toEqual(['c']);
        await s.deleteSchedule('a');
        await s.deleteSchedule('missing'); // idempotent no-op
        expect((await s.listSchedules()).map((x) => x.id).sort()).toEqual(['b', 'c']);
      });

      it('updateSchedule patches only the given fields; unknown id is a no-op', async () => {
        await s.createSchedule(makeSchedule());
        await s.updateSchedule('sched-1', { paused: true, data: { idSeller: 3 } });
        const mid = await s.getSchedule('sched-1');
        expect(mid!.paused).toBe(true);
        expect(mid!.data).toEqual({ idSeller: 3 });
        expect(mid!.schedule).toEqual(makeSchedule().schedule); // untouched
        expect(mid!.nextRunAt).toEqual(makeSchedule().nextRunAt); // untouched
        await expect(s.updateSchedule('missing', { paused: true })).resolves.toBeUndefined();
      });
    });

    describe('schedules tick loop (slice 2: engine on schedules)', () => {
      const now = new Date('2026-08-16T10:00:00Z');

      it('selects due, unlocked, unpaused, enabled schedules ordered by priority DESC, nextRunAt ASC', async () => {
        await s.createSchedule(makeSchedule({ id: 'b', nextRunAt: new Date('2026-08-16T09:45:00Z') }));
        await s.createSchedule(makeSchedule({ id: 'a', nextRunAt: new Date('2026-08-16T09:30:00Z') }));
        await s.createSchedule(makeSchedule({ id: 'future', nextRunAt: new Date('2026-08-17T00:00:00Z') }));
        expect((await s.listDueSchedules(now)).map((x) => x.id)).toEqual(['a', 'b']);
      });

      it('orders by priority DESC first, then nextRunAt ASC', async () => {
        await s.createSchedule(makeSchedule({ id: 'urgent', priority: 10, nextRunAt: new Date('2026-08-16T09:59:00Z') }));
        await s.createSchedule(makeSchedule({ id: 'normal', priority: 0, nextRunAt: new Date('2026-08-16T09:00:00Z') }));
        await s.createSchedule(makeSchedule({ id: 'high', priority: 5, nextRunAt: new Date('2026-08-16T09:30:00Z') }));
        expect((await s.listDueSchedules(now)).map((x) => x.id)).toEqual(['urgent', 'high', 'normal']);
      });

      it('excludes locked, paused, disabled, and null-nextRunAt schedules', async () => {
        await s.createSchedule(makeSchedule({ id: 'locked', lockedAt: new Date('2026-08-16T09:00:00Z') }));
        await s.createSchedule(makeSchedule({ id: 'paused', paused: true }));
        await s.createSchedule(makeSchedule({ id: 'disabled', disabled: true }));
        await s.createSchedule(makeSchedule({ id: 'done', nextRunAt: null }));
        expect(await s.listDueSchedules(now)).toHaveLength(0);
      });

      it('per-task ceiling: a second schedule of a locked task is not due and not claimable', async () => {
        await s.createSchedule(makeSchedule({ id: 'x-a', taskName: 'x', nextRunAt: new Date('2026-08-16T09:00:00Z') }));
        await s.createSchedule(makeSchedule({ id: 'x-b', taskName: 'x', nextRunAt: new Date('2026-08-16T09:00:00Z') }));
        expect(await s.claimSchedule('x-a', new Date('2026-08-16T09:00:00Z'))).toBe(true);
        // same task, other schedule: excluded from due AND the atomic claim refuses
        expect((await s.listDueSchedules(now)).map((x) => x.id)).toEqual([]);
        expect(await s.claimSchedule('x-b', new Date('2026-08-16T09:00:01Z'))).toBe(false);
        // a different task's schedule is unaffected
        await s.createSchedule(makeSchedule({ id: 'y-a', taskName: 'y', nextRunAt: new Date('2026-08-16T09:00:00Z') }));
        expect(await s.claimSchedule('y-a', new Date('2026-08-16T09:00:02Z'))).toBe(true);
      });

      it('claims a free schedule exactly once (atomic) and records the lock timestamp', async () => {
        await s.createSchedule(makeSchedule());
        const at = new Date('2026-08-16T09:00:00Z');
        expect(await s.claimSchedule('sched-1', at)).toBe(true);
        expect(await s.claimSchedule('sched-1', new Date('2026-08-16T09:00:01Z'))).toBe(false);
        expect((await s.getSchedule('sched-1'))!.lockedAt).toEqual(at);
      });

      it('refuses to claim a paused or disabled schedule', async () => {
        await s.createSchedule(makeSchedule({ paused: true }));
        expect(await s.claimSchedule('sched-1', new Date('2026-08-16T09:00:00Z'))).toBe(false);
        await s.createSchedule(makeSchedule({ disabled: true }));
        expect(await s.claimSchedule('sched-1', new Date('2026-08-16T09:00:00Z'))).toBe(false);
      });

      it('completeSchedule clears the lock, advances next/last, failCount on failed, retryCount absolute', async () => {
        const done: CompleteResult = {
          nextRunAt: new Date('2026-08-17T09:00:00Z'),
          lastRunAt: new Date('2026-08-16T09:05:00Z'),
          failed: false,
          retryCount: 0,
          lastRunId: 'r9',
        };
        await s.createSchedule(makeSchedule({ lockedAt: new Date('2026-08-16T09:00:00Z'), retryCount: 2 }));
        await s.completeSchedule('sched-1', done);
        const sch = await s.getSchedule('sched-1');
        expect(sch!.lockedAt).toBeNull();
        expect(sch!.nextRunAt).toEqual(done.nextRunAt);
        expect(sch!.lastRunAt).toEqual(done.lastRunAt);
        expect(sch!.lastRunId).toBe('r9');
        expect(sch!.failCount).toBe(0);
        expect(sch!.retryCount).toBe(0);

        await s.completeSchedule('sched-1', { ...done, failed: true, retryCount: 3 });
        expect((await s.getSchedule('sched-1'))!.failCount).toBe(1);
        expect((await s.getSchedule('sched-1'))!.retryCount).toBe(3);
      });

      it('reapZombieScheduleLocks unlocks stale locks and bumps failCount; leaves fresh locks alone', async () => {
        const olderThan = new Date('2026-08-16T09:00:00Z');
        await s.createSchedule(makeSchedule({ id: 'stale', lockedAt: new Date('2026-08-16T08:00:00Z') }));
        await s.createSchedule(makeSchedule({ id: 'fresh', lockedAt: new Date('2026-08-16T09:05:00Z') }));
        await s.createSchedule(makeSchedule({ id: 'free' }));
        expect(await s.reapZombieScheduleLocks(olderThan)).toBe(1);
        expect((await s.getSchedule('stale'))!.lockedAt).toBeNull();
        expect((await s.getSchedule('stale'))!.failCount).toBe(1);
        expect((await s.getSchedule('fresh'))!.lockedAt).not.toBeNull();
      });

      it('refreshScheduleLock extends a claimed lock; no-op when unlocked or unknown', async () => {
        await s.createSchedule(makeSchedule({ lockedAt: new Date('2026-08-16T09:00:00Z') }));
        await s.refreshScheduleLock('sched-1', new Date('2026-08-16T10:30:00Z'));
        expect((await s.getSchedule('sched-1'))!.lockedAt).toEqual(new Date('2026-08-16T10:30:00Z'));
        await s.createSchedule(makeSchedule({ id: 'free' }));
        await s.refreshScheduleLock('free', new Date('2026-08-16T10:30:00Z'));
        expect((await s.getSchedule('free'))!.lockedAt).toBeNull();
        await expect(s.refreshScheduleLock('nope', new Date('2026-08-16T10:30:00Z'))).resolves.toBeUndefined();
      });

      it('clearScheduleLocks releases every schedule lock without touching other state', async () => {
        await s.createSchedule(makeSchedule({ id: 'a', lockedAt: new Date('2026-08-16T09:00:00Z') }));
        await s.createSchedule(makeSchedule({ id: 'b', lockedAt: new Date('2026-08-16T10:00:00Z') }));
        expect(await s.clearScheduleLocks()).toBe(2);
        expect((await s.getSchedule('a'))!.lockedAt).toBeNull();
        expect((await s.getSchedule('b'))!.lockedAt).toBeNull();
        expect((await s.getSchedule('a'))!.failCount).toBe(0); // not reap — no failCount bump
        expect((await s.getSchedule('a'))!.nextRunAt).toEqual(makeSchedule().nextRunAt);
      });
    });

    describe('run history', () => {
      /** 2026-08-16 at `h` o'clock UTC — distinct, deterministic start times. */
      const at = (h: number): Date => new Date(`2026-08-16T${String(h).padStart(2, '0')}:00:00Z`);

      const baseRun: RunRecord = {
        id: 'r1',
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
      };

      const fullRun: RunRecord = {
        ...baseRun,
        status: 'queued',
        data: { dryRun: true, page: 2 },
        progress: 42,
        log: 'line1\nline2',
        workerRef: 'http://worker:3000/status/r1',
      };

      const artifacts: ArtifactRef[] = [
        { kind: 's3', ref: 's3://bucket/report.pdf', label: 'Отчёт' },
        { kind: 'url', ref: 'https://example.com/out', label: null },
      ];

      it('round-trips a run with all v2 fields (data/result/progress/log/artifacts/workerRef/queued)', async () => {
        await s.createRun({ ...fullRun, result: { ok: true, count: 7 } });
        expect(await s.getRun('r1')).toEqual({ ...fullRun, result: { ok: true, count: 7 } });
      });

      it('round-trips run metadata parity (trigger/triggeredBy/temporary/retryOf/scheduleId)', async () => {
        await s.createRun({
          ...baseRun,
          status: 'failed',
          trigger: 'manual',
          triggeredBy: 'user@example.com',
          temporary: true,
          retryOf: 'r0',
          scheduleId: 'sched-7',
        });
        expect(await s.getRun('r1')).toEqual({
          ...baseRun,
          status: 'failed',
          trigger: 'manual',
          triggeredBy: 'user@example.com',
          temporary: true,
          retryOf: 'r0',
          scheduleId: 'sched-7',
        });
      });

      it('round-trips a minimal running run (null v2 fields)', async () => {
        await s.createRun(baseRun);
        expect(await s.getRun('r1')).toEqual(baseRun);
      });

      it('getRun returns null for a missing run', async () => {
        expect(await s.getRun('missing')).toBeNull();
      });

      it('deleteRun removes a run; getRun then returns null', async () => {
        await s.createRun(baseRun);
        await s.deleteRun('r1');
        expect(await s.getRun('r1')).toBeNull();
      });

      it('deleteRun is a no-op for an unknown run', async () => {
        await expect(s.deleteRun('missing')).resolves.toBeUndefined();
      });

      it('listRuns returns runs newest-first, empty when none', async () => {
        expect(await s.listRuns()).toEqual([]);
        await s.createRun({ ...baseRun, id: 'r1', startedAt: new Date('2026-08-16T09:00:00Z') });
        await s.createRun({ ...baseRun, id: 'r2', startedAt: new Date('2026-08-16T10:00:00Z') });
        await s.createRun({ ...baseRun, id: 'r3', startedAt: new Date('2026-08-16T08:00:00Z') });
        expect((await s.listRuns()).map((r) => r.id)).toEqual(['r2', 'r1', 'r3']);
      });

      it('listRuns filters by taskName and status', async () => {
        await s.createRun({ ...baseRun, id: 'r1', taskName: 'task-a', status: 'succeeded' });
        await s.createRun({ ...baseRun, id: 'r2', taskName: 'task-a', status: 'failed' });
        await s.createRun({ ...baseRun, id: 'r3', taskName: 'task-b', status: 'succeeded' });
        const byTask = await s.listRuns({ taskName: 'task-a' });
        expect(byTask.map((r) => r.id).sort()).toEqual(['r1', 'r2']);
        const byStatus = await s.listRuns({ status: 'succeeded' });
        expect(byStatus.map((r) => r.id).sort()).toEqual(['r1', 'r3']);
        const both = await s.listRuns({ taskName: 'task-a', status: 'failed' });
        expect(both.map((r) => r.id)).toEqual(['r2']);
      });

      it('listRuns filters by the startedAt window, bounds inclusive', async () => {
        for (let h = 6; h <= 10; h++) {
          await s.createRun({ ...baseRun, id: `r${h}`, startedAt: at(h) });
        }
        expect((await s.listRuns({ since: at(7) })).map((r) => r.id)).toEqual(['r10', 'r9', 'r8', 'r7']);
        expect((await s.listRuns({ until: at(8) })).map((r) => r.id)).toEqual(['r8', 'r7', 'r6']);
        // both bounds inclusive: 07:00 and 09:00 rows must stay in
        expect((await s.listRuns({ since: at(7), until: at(9) })).map((r) => r.id)).toEqual(['r9', 'r8', 'r7']);
      });

      it('listRuns filters by runner and combines with taskName/status/window', async () => {
        await s.createRun({ ...baseRun, id: 'r1', taskName: 'task-a', runner: 'http', status: 'succeeded', startedAt: at(9) });
        await s.createRun({ ...baseRun, id: 'r2', taskName: 'task-a', runner: 'docker', status: 'succeeded', startedAt: at(10) });
        await s.createRun({ ...baseRun, id: 'r3', taskName: 'task-b', runner: 'docker', status: 'failed', startedAt: at(11) });

        expect((await s.listRuns({ runner: 'docker' })).map((r) => r.id)).toEqual(['r3', 'r2']);
        expect((await s.listRuns({ runner: 'http' })).map((r) => r.id)).toEqual(['r1']);
        const combined = await s.listRuns({ runner: 'docker', taskName: 'task-a', status: 'succeeded', since: at(9), until: at(10) });
        expect(combined.map((r) => r.id)).toEqual(['r2']);
      });

      it('listRuns keeps an unfinished run inside the window (finishedAt stays out of it)', async () => {
        // The window is anchored on startedAt, so a queued/running run is never
        // dropped the way a finishedAt window would drop it (docs/05.runs.md).
        await s.createRun({ ...baseRun, id: 'running', status: 'running', finishedAt: null, startedAt: at(8) });
        await s.createRun({ ...baseRun, id: 'done', status: 'succeeded', finishedAt: at(9), startedAt: at(8) });
        expect((await s.listRuns({ since: at(8), until: at(8) })).map((r) => r.id).sort()).toEqual(['done', 'running']);
        expect((await s.listRuns({ status: 'running', since: at(8), until: at(8) })).map((r) => r.id)).toEqual(['running']);
      });

      it('listRuns returns empty when no run matches the filter', async () => {
        await s.createRun({ ...baseRun, id: 'r1', runner: 'http', startedAt: at(9) });
        expect(await s.listRuns({ since: at(20) })).toEqual([]);
        expect(await s.listRuns({ until: at(1) })).toEqual([]);
        expect(await s.listRuns({ runner: 'docker' })).toEqual([]);
        expect(await s.listRuns({ taskName: 'task-a', status: 'failed' })).toEqual([]);
      });

      it('listRuns applies limit and offset', async () => {
        for (let i = 1; i <= 5; i++) {
          await s.createRun({ ...baseRun, id: `r${i}`, startedAt: new Date(`2026-08-16T0${i}:00:00Z`) });
        }
        const page = await s.listRuns({ limit: 2, offset: 1 });
        expect(page.map((r) => r.id)).toEqual(['r4', 'r3']); // newest-first: r5,r4,r3,r2,r1 → skip 1, take 2
      });

      it('listRuns applies limit and offset inside a window', async () => {
        for (let h = 6; h <= 10; h++) {
          await s.createRun({ ...baseRun, id: `r${h}`, startedAt: at(h) });
        }
        // window [07:00, 09:00] → r9,r8,r7 newest-first; skip 1, take 1
        expect((await s.listRuns({ since: at(7), until: at(9), limit: 1, offset: 1 })).map((r) => r.id)).toEqual(['r8']);
        expect((await s.listRuns({ since: at(7), until: at(9), limit: 2 })).map((r) => r.id)).toEqual(['r9', 'r8']);
      });

      it('finishRun sets terminal status + finishedAt and carries result/log/progress/artifacts', async () => {
        await s.createRun(baseRun);
        await s.finishRun('r1', {
          status: 'failed',
          error: 'boom',
          result: null,
          progress: 100,
          log: 'stack trace…',
          artifacts,
        });
        const done = await s.getRun('r1');
        expect(done!.status).toBe('failed');
        expect(done!.error).toBe('boom');
        expect(done!.result).toBeNull();
        expect(done!.progress).toBe(100);
        expect(done!.log).toBe('stack trace…');
        expect(done!.artifacts).toEqual(artifacts);
        expect(done!.finishedAt).not.toBeNull();
      });

      it('updateRun patches only the given fields mid-flight', async () => {
        await s.createRun(baseRun);
        await s.updateRun('r1', { progress: 25, log: 'halfway' });
        const mid = await s.getRun('r1');
        expect(mid!.progress).toBe(25);
        expect(mid!.log).toBe('halfway');
        expect(mid!.status).toBe('running');
        expect(mid!.result).toBeNull();
        expect(mid!.finishedAt).toBeNull();
        expect(mid!.workerRef).toBeNull();

        await s.updateRun('r1', { workerRef: 'http://worker:3000/status/r1', result: { part: 1 } });
        const later = await s.getRun('r1');
        expect(later!.workerRef).toBe('http://worker:3000/status/r1');
        expect(later!.result).toEqual({ part: 1 });
        expect(later!.progress).toBe(25); // untouched
      });

      it('updateRun can clear a field back to null', async () => {
        await s.createRun({ ...baseRun, log: 'stale' });
        await s.updateRun('r1', { log: null });
        expect((await s.getRun('r1'))!.log).toBeNull();
      });
    });

    describe('pruneRuns (retention sweep)', () => {
      const olderThan = new Date('2026-08-10T00:00:00Z');
      const old = new Date('2026-08-09T00:00:00Z'); // finished before olderThan
      const fresh = new Date('2026-08-11T00:00:00Z');
      const baseRun: RunRecord = {
        id: 'r',
        taskName: 'task-a',
        runner: 'http',
        startedAt: new Date('2026-08-01T00:00:00Z'),
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
      };

      it('deletes only terminal runs of the matching temporary class finished before olderThan', async () => {
        await s.createRun({ ...baseRun, id: 'temp-old', temporary: true, status: 'succeeded', finishedAt: old });
        await s.createRun({ ...baseRun, id: 'temp-old-failed', temporary: true, status: 'failed', finishedAt: old });
        await s.createRun({ ...baseRun, id: 'reg-old', temporary: false, status: 'succeeded', finishedAt: old }); // other class
        await s.createRun({ ...baseRun, id: 'temp-fresh', temporary: true, status: 'succeeded', finishedAt: fresh });
        await s.createRun({ ...baseRun, id: 'temp-running', temporary: true, status: 'running', finishedAt: null });

        expect(await s.pruneRuns({ olderThan, temporary: true })).toBe(2);
        const remaining = (await s.listRuns()).map((r) => r.id).sort();
        expect(remaining).toEqual(['reg-old', 'temp-fresh', 'temp-running']);
      });

      it('prunes the regular class separately', async () => {
        await s.createRun({ ...baseRun, id: 'temp-old', temporary: true, status: 'succeeded', finishedAt: old });
        await s.createRun({ ...baseRun, id: 'reg-old', temporary: false, status: 'succeeded', finishedAt: old });
        await s.createRun({ ...baseRun, id: 'reg-cancelled', temporary: false, status: 'cancelled', finishedAt: old });
        await s.createRun({ ...baseRun, id: 'reg-queued', temporary: false, status: 'queued', finishedAt: null });

        expect(await s.pruneRuns({ olderThan, temporary: false })).toBe(2);
        const remaining = (await s.listRuns()).map((r) => r.id).sort();
        expect(remaining).toEqual(['reg-queued', 'temp-old']);
      });

      it('is a no-op when nothing is old enough', async () => {
        await s.createRun({ ...baseRun, id: 'temp-fresh', temporary: true, status: 'succeeded', finishedAt: fresh });
        expect(await s.pruneRuns({ olderThan, temporary: true })).toBe(0);
        expect((await s.listRuns()).map((r) => r.id)).toEqual(['temp-fresh']);
      });
    });
  });
}
