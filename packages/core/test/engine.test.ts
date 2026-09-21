import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { createEngine } from '../src/engine.js';
import { createTaskOps } from '../src/task-ops.js';
import { resolveSchedulePolicy } from '../src/policy.js';
import type { EngineEvent, PollResult, RunOutcome, Runner, RunnerRunHooks } from '../src/engine.js';
import { createSqliteStorage } from '../src/sqlite.js';
import type { TaskRecord } from '../src/types.js';
import type { Storage } from '../src/storage.js';
import { MemoryStorage } from './helpers/memory-storage.js';
import { makeTask } from '../src/storage-contract.js';

function makeRunner(
  impl?: (
    task: TaskRecord,
    runId: string,
    startedAt: Date,
    hooks?: RunnerRunHooks,
  ) => Promise<RunOutcome>,
  pollImpl?: (runId: string, statusUrl: string, task?: TaskRecord) => Promise<PollResult>,
  cancelImpl?: (runId: string, statusUrl: string, task?: TaskRecord, cancelUrl?: string | null) => Promise<number | void>,
): {
  runner: Runner;
  calls: Array<{ task: TaskRecord; runId: string; startedAt: Date; hooks: RunnerRunHooks | undefined }>;
  pollCalls: Array<{ runId: string; statusUrl: string; task: TaskRecord | undefined }>;
  cancelCalls: Array<{ runId: string; statusUrl: string; task: TaskRecord | undefined; cancelUrl: string | null | undefined }>;
} {
  const calls: Array<{ task: TaskRecord; runId: string; startedAt: Date; hooks: RunnerRunHooks | undefined }> = [];
  const pollCalls: Array<{ runId: string; statusUrl: string; task: TaskRecord | undefined }> = [];
  const cancelCalls: Array<{ runId: string; statusUrl: string; task: TaskRecord | undefined; cancelUrl: string | null | undefined }> = [];
  const runner: Runner = {
    async run(task, runId, startedAt, hooks) {
      calls.push({ task, runId, startedAt, hooks });
      return impl ? impl(task, runId, startedAt, hooks) : { status: 'succeeded' };
    },
    async poll(runId, statusUrl, task) {
      pollCalls.push({ runId, statusUrl, task });
      return pollImpl ? pollImpl(runId, statusUrl, task) : { status: 'succeeded' };
    },
    async cancel(runId, statusUrl, task, cancelUrl) {
      cancelCalls.push({ runId, statusUrl, task, cancelUrl });
      return cancelImpl ? cancelImpl(runId, statusUrl, task, cancelUrl) : undefined;
    },
  };
  return { runner, calls, pollCalls, cancelCalls };
}

const NOON = new Date('2026-08-16T12:00:00Z');

/**
 * Slice-2 seed: upsert the task AND its schedule row (id = task name, mirroring
 * the v0.7 migration). The engine drives schedules since slice 2 — a task
 * without a schedule row never fires. `data` stays null so the dispatch view
 * and run snapshot match v1 (tests that exercise schedule data set it explicitly).
 */
async function seedTask(storage: Storage, task: TaskRecord): Promise<void> {
  await storage.upsertTask(task);
  if (task.schedule) {
    await storage.createSchedule({
      id: task.name,
      taskName: task.name,
      schedule: task.schedule,
      tz: task.tz,
      data: null,
      externalId: null,
      dedupKey: null,
      nextRunAt: task.nextRunAt,
      lastRunAt: task.lastRunAt,
      lockedAt: task.lockedAt,
      failCount: task.failCount,
      priority: task.priority,
      retry: task.retry,
      retryCount: task.retryCount,
      lastRunId: task.lastRunId,
      paused: task.paused,
      disabled: task.disabled,
      fileManaged: true,
    });
  }
}

describe('engine — tick', () => {
  it('does nothing when no tasks are due', async () => {
    const storage = new MemoryStorage();
    const { runner, calls } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOON });
    await engine.runOnce();
    expect(calls).toHaveLength(0);
  });

  it('fires a due cron task and reschedules the next occurrence from completion time', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const { runner, calls } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOON });

    await engine.runOnce();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.task.name).toBe('task-a');
    expect(calls[0]!.startedAt).toEqual(NOON);

    const [run] = [...storage.runs.values()];
    expect(run!.status).toBe('succeeded');
    expect(run!.taskName).toBe('task-a');

    const t = await storage.getSchedule('task-a');
    expect(t!.lockedAt).toBeNull();
    expect(t!.lastRunAt).toEqual(NOON);
    // daily cron '0 9 * * *' from 12:00Z → next 09:00 is tomorrow
    expect(t!.nextRunAt!.getTime()).toBe(Date.parse('2026-08-17T09:00:00Z'));
    expect(t!.failCount).toBe(0);
  });

  it('advances an interval schedule by its duration from completion', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ schedule: { kind: 'interval', ms: 300_000 }, nextRunAt: new Date('2026-08-16T11:59:00Z') }),
    );
    const engine = createEngine({ storage, runner: makeRunner().runner, now: () => NOON });

    await engine.runOnce();

    const t = await storage.getSchedule('task-a');
    expect(t!.nextRunAt!.getTime()).toBe(Date.parse('2026-08-16T12:05:00Z'));
  });

  it('snapshots task.config.data into the RunRecord (v2 data contract)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ config: { image: 'alpine', data: { idPickingList: 42 } }, nextRunAt: new Date('2026-08-16T11:59:00Z') }),
    );
    const { runner } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOON });

    await engine.runOnce();

    const [run] = [...storage.runs.values()];
    expect(run!.status).toBe('succeeded');
    expect(run!.data).toEqual({ idPickingList: 42 });
  });

  it('records run metadata parity on a scheduled run (trigger=schedule, temporary=false, retryOf=null)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const { runner } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOON });

    await engine.runOnce();

    const [run] = [...storage.runs.values()];
    expect(run!.trigger).toBe('schedule');
    expect(run!.triggeredBy).toBeNull();
    expect(run!.temporary).toBe(false);
    expect(run!.retryOf).toBeNull();
  });

  it('snapshots config.body into the RunRecord on triggerTask (raw body fallback)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ config: { url: 'http://w/', body: { force: true } } }));
    const { runner } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOON });

    const run = await engine.triggerTask('task-a');

    expect(run!.data).toEqual({ force: true });
    expect(run!.status).toBe('succeeded');
  });

  it('records trigger=manual + triggeredBy + temporary and merges the data override (books one-off parity)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ config: { data: { base: 1 } } }));
    const { runner } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOON });

    const run = await engine.triggerTask('task-a', {
      data: { idPickingList: 42 },
      temporary: true,
      triggeredBy: 'user@example.com',
    });

    expect(run!.trigger).toBe('manual');
    expect(run!.triggeredBy).toBe('user@example.com');
    expect(run!.temporary).toBe(true);
    expect(run!.retryOf).toBeNull();
    expect(run!.data).toEqual({ base: 1, idPickingList: 42 }); // merge, not replace
    expect(run!.status).toBe('succeeded');
  });

  it('triggerTask without opts keeps the task default data and manual defaults', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ config: { data: { base: 1 } } }));
    const { runner } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOON });

    const run = await engine.triggerTask('task-a');

    expect(run!.data).toEqual({ base: 1 });
    expect(run!.trigger).toBe('manual');
    expect(run!.triggeredBy).toBeNull();
    expect(run!.temporary).toBe(false);
  });

  it('triggerTask validates the merged data against inputSchema and throws on mismatch', async () => {
    const storage = new MemoryStorage();
    await seedTask(
      storage,
      makeTask({
        inputSchema: {
          type: 'object',
          properties: { idSeller: { type: 'integer', minimum: 1 } },
          required: ['idSeller'],
        },
      }),
    );
    const { runner } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOON });

    await expect(engine.triggerTask('task-a', { data: { idSeller: 'two' } })).rejects.toThrow(/inputSchema/);
    await expect(engine.triggerTask('task-a', { data: {} })).rejects.toThrow(/required property is missing/);
  });

  it('triggerTask applies inputSchema defaults — the run records the effective data', async () => {
    const storage = new MemoryStorage();
    await seedTask(
      storage,
      makeTask({
        inputSchema: {
          type: 'object',
          properties: { idSeller: { type: 'integer' }, mode: { type: 'string', default: 'auto' } },
          required: ['idSeller'],
        },
      }),
    );
    const { runner } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOON });

    const run = await engine.triggerTask('task-a', { data: { idSeller: 7 } });

    expect(run!.data).toEqual({ idSeller: 7, mode: 'auto' });
    expect(run!.status).toBe('succeeded');
  });

  it('triggerTask without inputSchema accepts any data (legacy behavior)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask());
    const { runner } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOON });

    const run = await engine.triggerTask('task-a', { data: { anything: [1, 2, 3] } });
    expect(run!.data).toEqual({ anything: [1, 2, 3] });
  });

  it('manual trigger dispatches the runner with the merged data override (dispatch view, books parity)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ config: { data: { base: 1 } } }));
    const { runner, calls } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOON });

    await engine.triggerTask('task-a', { data: { idPickingList: 42 } });

    // the runner must see the override as the payload — not the raw task defaults
    expect(calls[0]!.task.config.data).toEqual({ base: 1, idPickingList: 42 });
    expect(calls[0]!.task.config.body).toEqual({ base: 1, idPickingList: 42 });
  });

  it('manual trigger without override leaves the dispatch view at task defaults', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ config: { data: { base: 1 }, body: { legacy: true } } }));
    const { runner, calls } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOON });

    await engine.triggerTask('task-a');

    expect(calls[0]!.task.config.data).toEqual({ base: 1 });
    expect(calls[0]!.task.config.body).toEqual({ legacy: true });
  });

  it('retryRun re-executes the original with data/retryOf/temporary inherited and a fresh triggeredBy', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask());
    let failFirst = true;
    const { runner } = makeRunner(async () => {
      if (failFirst) {
        failFirst = false;
        return { status: 'failed', error: 'boom' };
      }
      return { status: 'succeeded' };
    });
    const engine = createEngine({ storage, runner, now: () => NOON });

    const original = await engine.triggerTask('task-a', { data: { x: 1 }, temporary: true });
    expect(original!.status).toBe('failed');

    const retried = await engine.retryRun(original!.id, { triggeredBy: 'admin@example.com' });

    expect(retried!.id).not.toBe(original!.id);
    expect(retried!.status).toBe('succeeded');
    expect(retried!.trigger).toBe('manual');
    expect(retried!.triggeredBy).toBe('admin@example.com'); // fresh actor, not inherited
    expect(retried!.temporary).toBe(true); // retention class inherited from the original
    expect(retried!.retryOf).toBe(original!.id);
    expect(retried!.data).toEqual({ x: 1 }); // run.data snapshot, not task defaults
    // original untouched (audit trail preserved)
    expect((await storage.getRun(original!.id))!.status).toBe('failed');
  });

  it('retryRun dispatches the runner with the original run data (dispatch view, decision 6 parity)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask()); // no default data — override is the only source
    let failFirst = true;
    const { runner, calls } = makeRunner(async () => {
      if (failFirst) {
        failFirst = false;
        return { status: 'failed', error: 'boom' };
      }
      return { status: 'succeeded' };
    });
    const engine = createEngine({ storage, runner, now: () => NOON });

    const original = await engine.triggerTask('task-a', { data: { x: 1 } });
    expect(original!.status).toBe('failed');
    await engine.retryRun(original!.id);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.task.config.data).toEqual({ x: 1 }); // original dispatch view
    expect(calls[1]!.task.config.data).toEqual({ x: 1 }); // retry dispatch view = run.data, not task defaults
  });

  it('retryRun returns null for an unknown run', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine({ storage, runner: makeRunner().runner, now: () => NOON });
    expect(await engine.retryRun('nope')).toBeNull();
  });

  it('retryRun returns null when the run survives but its task is gone', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask());
    const { runner } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOON });
    const original = await engine.triggerTask('task-a');
    await storage.deleteTask('task-a');
    expect(await engine.retryRun(original!.id)).toBeNull();
  });

  it('does not reschedule a one-shot (schedule exhausted)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ schedule: { kind: 'once', at: new Date('2026-08-16T11:00:00Z') }, nextRunAt: new Date('2026-08-16T11:00:00Z') }),
    );
    const engine = createEngine({ storage, runner: makeRunner().runner, now: () => NOON });

    await engine.runOnce();

    const t = await storage.getSchedule('task-a');
    expect(t!.nextRunAt).toBeNull();
  });

  it('records a failed run and bumps failCount when the runner reports failure', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const { runner } = makeRunner(async () => ({ status: 'failed', error: 'boom' }));
    const engine = createEngine({ storage, runner, now: () => NOON });

    await engine.runOnce();

    const [run] = [...storage.runs.values()];
    expect(run!.status).toBe('failed');
    expect(run!.error).toBe('boom');
    const t = await storage.getSchedule('task-a');
    expect(t!.failCount).toBe(1);
  });

  it('stores the enriched outcome (result/log/progress/artifacts) on a successful run', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const artifacts = [
      { kind: 's3' as const, ref: 's3://bucket/report.pdf', label: 'Отчёт' },
      { kind: 'url' as const, ref: 'https://example.com/out', label: null },
    ];
    const { runner } = makeRunner(async () => ({
      status: 'succeeded',
      result: { ok: true, count: 7 },
      progress: 100,
      log: 'all good',
      artifacts,
    }));
    const engine = createEngine({ storage, runner, now: () => NOON });

    await engine.runOnce();

    const [run] = [...storage.runs.values()];
    expect(run!.status).toBe('succeeded');
    expect(run!.result).toEqual({ ok: true, count: 7 });
    expect(run!.progress).toBe(100);
    expect(run!.log).toBe('all good');
    expect(run!.artifacts).toEqual(artifacts);
    expect(run!.finishedAt).not.toBeNull();
    expect((await storage.getSchedule('task-a'))!.failCount).toBe(0);
  });

  it('passes an onProgress callback to the runner during dispatch', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    let hook: RunnerRunHooks | undefined;
    const { runner } = makeRunner(async (_t, _rid, _at, hooks) => {
      hook = hooks;
      return { status: 'succeeded' };
    });
    const engine = createEngine({ storage, runner, now: () => NOON });
    await engine.runOnce();
    expect(hook?.onProgress).toBeTypeOf('function');
  });

  it('keeps result/log from a failed run', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const { runner } = makeRunner(async () => ({
      status: 'failed',
      error: 'timeout after 3 retries',
      log: 'attempt 1… attempt 2…',
    }));
    const engine = createEngine({ storage, runner, now: () => NOON });

    await engine.runOnce();

    const [run] = [...storage.runs.values()];
    expect(run!.status).toBe('failed');
    expect(run!.error).toBe('timeout after 3 retries');
    expect(run!.log).toBe('attempt 1… attempt 2…');
  });

  it('defaults enriched fields to null when the runner reports a bare outcome', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const { runner } = makeRunner(); // bare { status: 'succeeded' }
    const engine = createEngine({ storage, runner, now: () => NOON });

    await engine.runOnce();

    const [run] = [...storage.runs.values()];
    expect(run!.status).toBe('succeeded');
    expect(run!.result).toBeNull();
    expect(run!.progress).toBeNull();
    expect(run!.log).toBeNull();
    expect(run!.artifacts).toBeNull();
  });

  it('treats a throwing runner as a failed run (engine does not crash)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const { runner } = makeRunner(async () => {
      throw new Error('runner exploded');
    });
    const engine = createEngine({ storage, runner, now: () => NOON });

    await engine.runOnce();

    const [run] = [...storage.runs.values()];
    expect(run!.status).toBe('failed');
    expect(run!.error).toContain('runner exploded');
    expect((await storage.getSchedule('task-a'))!.failCount).toBe(1);
  });

  it('skips locked, paused, and disabled tasks', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ name: 'locked', lockedAt: new Date('2026-08-16T10:00:00Z') }));
    await seedTask(storage, makeTask({ name: 'paused', paused: true }));
    await seedTask(storage, makeTask({ name: 'disabled', disabled: true }));
    const { runner, calls } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOON });

    await engine.runOnce();

    expect(calls).toHaveLength(0);
  });

  it('is non-reentrant: a second runOnce while one is in flight is skipped', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { runner, calls } = makeRunner(async () => {
      await gate;
      return { status: 'succeeded' };
    });
    const engine = createEngine({ storage, runner, now: () => NOON });

    const first = engine.runOnce();
    const second = engine.runOnce();
    release();
    await Promise.all([first, second]);

    expect(calls).toHaveLength(1);
  });
});

describe('engine — schedules (slice 2: engine drives schedule rows)', () => {
  it('schedule-fired runs carry scheduleId; manual runs stay null', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const { runner } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOON });
    await engine.runOnce();

    const run = [...storage.runs.values()][0]!;
    expect(run.scheduleId).toBe('task-a'); // the schedule id (task name, per the v0.7 synthesis)
    expect(run.trigger).toBe('schedule');

    const manual = await engine.triggerTask('task-a');
    expect(manual!.scheduleId).toBeNull();
  });

  it('a schedule run dispatches with the schedule data (run snapshot + runner payload)', async () => {
    const storage = new MemoryStorage();
    const task = makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') });
    await seedTask(storage, task);
    await storage.updateSchedule('task-a', { data: { idSeller: 2 } });
    const { runner, calls } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOON });
    await engine.runOnce();

    const run = [...storage.runs.values()][0]!;
    expect(run.data).toEqual({ idSeller: 2 }); // snapshot from the schedule
    expect(calls[0]!.task.config.data).toEqual({ idSeller: 2 }); // dispatch view carries it to the runner
    // task defaults untouched when the schedule has no data
    const noData = new MemoryStorage();
    await seedTask(noData, makeTask({ config: { url: 'http://w', data: { base: 1 } }, nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const mk2 = makeRunner();
    const e2 = createEngine({ storage: noData, runner: mk2.runner, now: () => NOON });
    await e2.runOnce();
    expect(mk2.calls[0]!.task.config.data).toEqual({ base: 1 });
    expect([...noData.runs.values()][0]!.data).toEqual({ base: 1 });
  });

  it('per-task ceiling: a task with two due schedules runs them sequentially, never in parallel', async () => {
    const storage = new MemoryStorage();
    const task = makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') });
    await seedTask(storage, task);
    // a second schedule of the same task, also due
    await storage.createSchedule({
      id: 'task-a#1',
      taskName: 'task-a',
      schedule: { kind: 'interval', ms: 60_000 },
      tz: 'UTC',
      data: { idSeller: 3 },
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
    const { runner, calls } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOON, maxConcurrent: 2 });
    await engine.runOnce();

    // only ONE schedule of the task fired — the sibling is excluded by the ceiling
    expect(calls).toHaveLength(1);
    expect(calls[0]!.task.name).toBe('task-a');

    // second tick (first completed): the sibling schedule fires now
    await engine.runOnce(new Date('2026-08-16T12:00:01Z'));
    expect(calls).toHaveLength(2);
    const runs = [...storage.runs.values()].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    expect(runs.map((r) => r.scheduleId)).toEqual(['task-a', 'task-a#1']);
    expect(runs.map((r) => r.data)).toEqual([null, { idSeller: 3 }]);
  });

  it('catch-up: an overdue schedule fires once on the next tick, then reschedules from completion', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T08:00:00Z') })); // 4h overdue
    const { runner, calls } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOON });
    await engine.runOnce();

    expect(calls).toHaveLength(1); // fired once, no backfill of missed slots
    const sch = await storage.getSchedule('task-a');
    expect(sch!.nextRunAt!.getTime()).toBe(Date.parse('2026-08-17T09:00:00Z')); // next from completion, cron 0 9
  });

  it('retry planning uses the schedule policy (materialized at sync); retryCount lives on the schedule row', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ retry: { maxAttempts: 2, backoffMs: 60_000 }, nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const { runner } = makeRunner(async () => ({ status: 'failed', error: 'boom' }));
    const engine = createEngine({ storage, runner, now: () => NOON });
    await engine.runOnce();

    const sch = await storage.getSchedule('task-a');
    expect(sch!.retryCount).toBe(1); // runtime state on the SCHEDULE row
    expect(sch!.nextRunAt!.getTime()).toBe(Date.parse('2026-08-16T12:01:00Z')); // finished + backoff
    expect(sch!.failCount).toBe(0); // retry pending — not a persistent failure
  });
});

describe('engine — policy inheritance (slice 3)', () => {
  it('effective policy = schedule.retry ?? task.retry, WHOLE (no partial merge)', async () => {
    const task = makeTask({ retry: { maxAttempts: 3, backoffMs: 1000 } });
    const base = {
      id: 's',
      taskName: 'task-a',
      schedule: { kind: 'cron', cron: '0 9 * * *' } as const,
      tz: 'UTC',
      data: null,
      externalId: null,
      dedupKey: null,
      nextRunAt: null,
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
    };
    // unset → inherits the whole task policy
    expect(resolveSchedulePolicy(task, { ...base, retry: null })).toEqual({ retry: task.retry, priority: 0 });
    // set → the schedule's FULL policy wins, no field-level merge
    const override = { maxAttempts: 5, backoffMs: 5000, multiplier: 2 };
    expect(resolveSchedulePolicy(task, { ...base, retry: override })).toEqual({ retry: override, priority: 0 });
    // priority independently
    expect(resolveSchedulePolicy({ ...task, priority: 7 }, { ...base, priority: 10 })).toEqual({
      retry: task.retry,
      priority: 10,
    });
  });

  it('pause AND: task.paused stops every schedule (family stop); resumeTask restores', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    await storage.createSchedule({
      id: 'task-a#1',
      taskName: 'task-a',
      schedule: { kind: 'interval', ms: 60_000 },
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
    const ops = createTaskOps(storage);
    await ops.pauseTask('task-a'); // family stop
    const { runner, calls } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOON, maxConcurrent: 2 });
    await engine.runOnce();
    expect(calls).toHaveLength(0); // neither schedule fired

    await ops.resumeTask('task-a'); // clears ONLY the task level
    await engine.runOnce(new Date('2026-08-16T12:00:01Z'));
    expect(calls).toHaveLength(1); // ceiling 1: the first schedule fires, its sibling waits
    await engine.runOnce(new Date('2026-08-16T12:00:02Z'));
    expect(calls).toHaveLength(2); // sibling fires once the first completed
  });

  it('pause AND: schedule.paused stops one instance; resumeSchedule clears only its own level', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const ops = createTaskOps(storage);
    await ops.pauseTask('task-a'); // task paused
    await ops.pauseSchedule('task-a'); // schedule also paused
    await ops.resumeTask('task-a'); // task level cleared — schedule level still paused
    const { runner, calls } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOON });
    await engine.runOnce();
    expect(calls).toHaveLength(0); // still paused at the schedule level

    await ops.resumeSchedule('task-a');
    await engine.runOnce(new Date('2026-08-16T12:00:01Z'));
    expect(calls).toHaveLength(1);
  });

  it('a manual triggerTask uses the task defaults, never the schedule override', async () => {
    const storage = new MemoryStorage();
    const task = makeTask({ nextRunAt: new Date('2026-08-17T09:00:00Z') });
    await seedTask(storage, task);
    // the schedule overrides data — manual runs must NOT see it
    await storage.updateSchedule('task-a', { data: { idSeller: 2 }, retry: { maxAttempts: 5, backoffMs: 1000 } });
    const { runner, calls } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOON });

    const run = await engine.triggerTask('task-a');
    expect(run!.data).toBeNull(); // task defaults (no config data), not the schedule's { idSeller: 2 }
    expect(run!.scheduleId).toBeNull();
    expect(calls[0]!.task.config.data).toBeUndefined(); // dispatch view untouched
  });

  it('a pending retry is a due run of the schedule — pause gates it, resume re-arms it', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ retry: { maxAttempts: 2, backoffMs: 60_000 }, nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const { runner, calls } = makeRunner(async () => ({ status: 'failed', error: 'boom' }));
    const engine = createEngine({ storage, runner, now: () => NOON });
    await engine.runOnce(); // attempt 1 fails → retry pending at 12:01
    expect(calls).toHaveLength(1);
    expect((await storage.getSchedule('task-a'))!.retryCount).toBe(1);

    await storage.updateSchedule('task-a', { paused: true }); // pause in the backoff window
    await engine.runOnce(new Date('2026-08-16T12:01:00Z')); // retry due — gated by pause
    expect(calls).toHaveLength(1); // NOT fired

    await storage.updateSchedule('task-a', { paused: false });
    await engine.runOnce(new Date('2026-08-16T12:01:01Z')); // now it fires
    expect(calls).toHaveLength(2);
  });

  it('snapshot semantics: the pending retry fires even if policy changed in the window; the next planning reads fresh policy', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ retry: { maxAttempts: 2, backoffMs: 60_000 }, nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const { runner, calls } = makeRunner(async () => ({ status: 'failed', error: 'boom' }));
    const engine = createEngine({ storage, runner, now: () => NOON });
    await engine.runOnce(); // attempt 1 fails → retry planned at 12:01 (snapshot: maxAttempts 2, backoff 60s)
    expect(calls).toHaveLength(1);
    expect((await storage.getSchedule('task-a'))!.retryCount).toBe(1);

    await storage.updateSchedule('task-a', { retry: { maxAttempts: 5, backoffMs: 1000 } }); // edit in the backoff window
    await engine.runOnce(new Date('2026-08-16T12:01:00Z')); // the PENDING retry still fires — the edit does not cancel it
    expect(calls).toHaveLength(2);
    // its outcome is planned under the FRESH policy (maxAttempts 5, backoff 1s) → attempt 3 scheduled
    expect((await storage.getSchedule('task-a'))!.retryCount).toBe(2);
    expect((await storage.getSchedule('task-a'))!.failCount).toBe(0);
    // anchored at clock() (the injected constant NOON) — same convention as the backoff tests
    expect((await storage.getSchedule('task-a'))!.nextRunAt!.getTime()).toBe(Date.parse('2026-08-16T12:00:01Z'));
  });
});

describe('engine — concurrency + priority', () => {
  function inFlightRunner(): { runner: Runner; maxInFlight: () => number } {
    let inFlight = 0;
    let max = 0;
    const runner: Runner = {
      async run() {
        inFlight += 1;
        max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1;
        return { status: 'succeeded' };
      },
    };
    return { runner, maxInFlight: () => max };
  }

  it('runs due tasks in parallel up to maxConcurrent', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ name: 'a', nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    await seedTask(storage, makeTask({ name: 'b', nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    await seedTask(storage, makeTask({ name: 'c', nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const { runner, maxInFlight } = inFlightRunner();
    const engine = createEngine({ storage, runner, now: () => NOON, maxConcurrent: 2 });

    await engine.runOnce();

    expect(maxInFlight()).toBe(2);
    // all three tasks still ran
    expect((await storage.listTasks()).map((t) => t.name).sort()).toEqual(['a', 'b', 'c']);
    expect((await storage.listTasks()).every((t) => t.lockedAt === null)).toBe(true);
  });

  it('defaults to sequential execution when maxConcurrent is unset', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ name: 'a', nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    await seedTask(storage, makeTask({ name: 'b', nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const { runner, maxInFlight } = inFlightRunner();
    const engine = createEngine({ storage, runner, now: () => NOON });

    await engine.runOnce();

    expect(maxInFlight()).toBe(1);
  });

  it('claims higher-priority tasks first (priority DESC, then due time)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ name: 'low', priority: 0, nextRunAt: new Date('2026-08-16T11:55:00Z') }));
    await seedTask(storage, makeTask({ name: 'high', priority: 9, nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const { runner, calls } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOON });

    await engine.runOnce();

    expect(calls.map((c) => c.task.name)).toEqual(['high', 'low']);
  });

  it('claim prevents overlap: a still-locked task is skipped by the next tick', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { runner, calls } = makeRunner(async () => {
      await gate;
      return { status: 'succeeded' };
    });
    const engine = createEngine({ storage, runner, now: () => NOON, maxConcurrent: 2 });

    const first = engine.runOnce();
    const second = engine.runOnce(); // while the first run is still in flight (locked)
    release();
    await Promise.all([first, second]);

    expect(calls).toHaveLength(1);
  });
});

describe('engine — retry policy', () => {
  const retry = { maxAttempts: 2, backoffMs: 60_000 };

  it('schedules a retry on failure: nextRunAt = finished + backoff, no final alert, failCount untouched', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ retry, nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const finals: string[] = [];
    const { runner } = makeRunner(async () => ({ status: 'failed', error: 'boom' }));
    const engine = createEngine({ storage, runner, now: () => NOON, onRunFinal: (r) => { finals.push(r.status); } });

    await engine.runOnce();

    const t = await storage.getSchedule('task-a');
    expect(t!.retryCount).toBe(1);
    expect(t!.nextRunAt!.getTime()).toBe(Date.parse('2026-08-16T12:01:00Z')); // NOON + 60s
    expect(t!.failCount).toBe(0); // not a persistent failure yet
    expect(finals).toEqual([]); // alert deferred until retries are exhausted
    const [run] = [...storage.runs.values()];
    expect(run!.attempt).toBe(1);
    expect(run!.status).toBe('failed');
  });

  it('runs the retry as attempt 2, and a final failure after exhaustion bumps failCount + fires the final hook', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ retry, nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const finals: string[] = [];
    const { runner, calls } = makeRunner(async () => ({ status: 'failed', error: 'still down' }));
    const engine = createEngine({ storage, runner, now: () => NOON, onRunFinal: (r) => { finals.push(`${r.status}:${r.attempt}`); } });

    await engine.runOnce(); // attempt 1 fails → retry at 12:01
    await engine.runOnce(new Date('2026-08-16T12:01:00Z')); // attempt 2 fails → exhausted

    expect(calls).toHaveLength(2);
    const runs = [...storage.runs.values()].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    expect(runs.map((r) => r.attempt)).toEqual([1, 2]);
    const t = await storage.getSchedule('task-a');
    // retryCount resets after exhaustion — the next scheduled occurrence starts a fresh cycle
    expect(t!.retryCount).toBe(0);
    expect(t!.failCount).toBe(1); // final failure counted
    expect(finals).toEqual(['failed:2']); // only the exhausted failure alerted
    // schedule advanced normally from the final failure, not backoff
    expect(t!.nextRunAt!.getTime()).toBe(Date.parse('2026-08-17T09:00:00Z'));
  });

  it('links the retry run to the failed attempt via retryOf (task.lastRunId)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ retry: { maxAttempts: 2, backoffMs: 60_000 }, nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const { runner } = makeRunner(async () => ({ status: 'failed', error: 'boom' }));
    const engine = createEngine({ storage, runner, now: () => NOON });

    await engine.runOnce(); // attempt 1 fails → retry scheduled
    const attempt1 = [...storage.runs.values()][0]!;
    // engine wrote task.lastRunId at the finish — the retry links through it
    expect((await storage.getSchedule('task-a'))!.lastRunId).toBe(attempt1.id);

    await engine.runOnce(new Date('2026-08-16T12:01:00Z')); // attempt 2 (the retry)
    const runs = [...storage.runs.values()].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    expect(runs[1]!.retryOf).toBe(runs[0]!.id);
    expect(runs[1]!.trigger).toBe('schedule');
    expect(runs[1]!.attempt).toBe(2);
    // a fresh scheduled run after a success is NOT a retry
    expect(runs[1]!.retryOf).not.toBeNull();
  });

  it('resets retryCount after a success', async () => {
    const storage = new MemoryStorage();
    const task = makeTask({ retry, retryCount: 1, nextRunAt: new Date('2026-08-16T11:59:00Z') });
    await seedTask(storage, task);
    const engine = createEngine({ storage, runner: makeRunner().runner, now: () => NOON });

    await engine.runOnce();

    const t = await storage.getSchedule('task-a');
    expect(t!.retryCount).toBe(0);
    expect(t!.failCount).toBe(0);
  });

  it('grows the backoff exponentially when multiplier is set', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ retry: { maxAttempts: 3, backoffMs: 10_000, multiplier: 2 }, nextRunAt: new Date('2026-08-16T11:59:00Z') }),
    );
    const { runner } = makeRunner(async () => ({ status: 'failed', error: 'x' }));
    const engine = createEngine({ storage, runner, now: () => NOON });

    await engine.runOnce(); // retry 1: backoff = 10s * 2^0 = 10s (anchored at clock() = NOON)
    expect((await storage.getSchedule('task-a'))!.nextRunAt!.getTime()).toBe(Date.parse('2026-08-16T12:00:10Z'));

    await engine.runOnce(new Date('2026-08-16T12:00:10Z')); // retry 2: backoff = 10s * 2^1 = 20s
    expect((await storage.getSchedule('task-a'))!.nextRunAt!.getTime()).toBe(Date.parse('2026-08-16T12:00:20Z'));
  });

  it('retries async poll failures too, deferring the final hook until exhaustion', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ retry: { maxAttempts: 2, backoffMs: 30_000 }, nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const finals: string[] = [];
    const { runner } = makeRunner(
      async () => ({ status: 'accepted' as const, statusUrl: 'u', pollIntervalMs: 1000 }),
      async () => ({ status: 'failed', error: 'worker died' }),
    );
    const engine = createEngine({ storage, runner, now: () => NOON, onRunFinal: (r) => { finals.push(r.status); } });

    await engine.runOnce();
    await engine.runPollOnce(new Date('2026-08-16T12:00:01Z')); // poll failed → retry scheduled

    const t = await storage.getSchedule('task-a');
    expect(t!.retryCount).toBe(1);
    // backoff anchored at clock() (NOON) + 30s — the poll's wall clock is irrelevant
    expect(t!.nextRunAt!.getTime()).toBe(Date.parse('2026-08-16T12:00:30Z'));
    expect(t!.failCount).toBe(0);
    expect(finals).toEqual([]);
  });

  it('never auto-retries a manual triggerTask', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ retry, nextRunAt: new Date('2026-08-17T09:00:00Z') }));
    const finals: string[] = [];
    const { runner } = makeRunner(async () => ({ status: 'failed', error: 'boom' }));
    const engine = createEngine({ storage, runner, now: () => NOON, onRunFinal: (r) => { finals.push(r.status); } });

    const run = await engine.triggerTask('task-a');

    expect(run!.status).toBe('failed');
    expect(finals).toEqual(['failed']); // manual trigger alerts immediately
    const t = await storage.getSchedule('task-a');
    expect(t!.retryCount).toBe(0); // no retry consumed
    expect(t!.nextRunAt).toEqual(new Date('2026-08-17T09:00:00Z')); // schedule untouched
  });

  it('records the attempt number on runs (1-based)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ retry: { maxAttempts: 3, backoffMs: 1000 }, nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const { runner } = makeRunner(async () => ({ status: 'failed', error: 'x' }));
    const engine = createEngine({ storage, runner, now: () => NOON });

    await engine.runOnce();
    await engine.runOnce(new Date('2026-08-16T12:00:01Z'));

    const runs = [...storage.runs.values()].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    expect(runs.map((r) => r.attempt)).toEqual([1, 2]);
  });
});

describe('engine — triggerTask (ad-hoc, agenda.now equivalent)', () => {
  it('runs a task immediately without touching its schedule', async () => {
    const storage = new MemoryStorage();
    const task = makeTask({ nextRunAt: new Date('2026-08-17T09:00:00Z') });
    await seedTask(storage, task);
    const { runner, calls } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOON });

    const run = await engine.triggerTask('task-a');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.task.name).toBe('task-a');
    expect(run!.status).toBe('succeeded');
    // schedule untouched: nextRunAt still tomorrow, no lock
    const t = await storage.getTask('task-a');
    expect(t!.nextRunAt).toEqual(task.nextRunAt);
    expect(t!.lockedAt).toBeNull();
    expect(t!.failCount).toBe(0);
  });

  it('writes task.lastRunId/lastRunAt on manual trigger (r6 F5), schedule untouched', async () => {
    const storage = new MemoryStorage();
    const task = makeTask({ nextRunAt: new Date('2026-08-17T09:00:00Z') });
    await seedTask(storage, task);
    const { runner } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOON });

    const run = await engine.triggerTask('task-a');

    expect(run!.status).toBe('succeeded');
    const t = await storage.getTask('task-a');
    expect(t!.lastRunId).toBe(run!.id);
    expect(t!.lastRunAt).toEqual(NOON);
    expect(t!.nextRunAt).toEqual(task.nextRunAt); // schedule untouched
  });

  it('runs even a paused task (explicit manual trigger)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ paused: true }));
    const { runner, calls } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOON });

    const run = await engine.triggerTask('task-a');

    expect(calls).toHaveLength(1);
    expect(run!.status).toBe('succeeded');
  });

  it('returns null for a missing task', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine({ storage, runner: makeRunner().runner, now: () => NOON });
    expect(await engine.triggerTask('nope')).toBeNull();
  });

  it('records a failed outcome when the runner fails', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask());
    const { runner } = makeRunner(async () => ({ status: 'failed', error: 'boom' }));
    const engine = createEngine({ storage, runner, now: () => NOON });

    const run = await engine.triggerTask('task-a');

    expect(run!.status).toBe('failed');
    expect(run!.error).toBe('boom');
  });

  it('does not crash when a runner accepts without poll() (manual trigger)', async () => {
    // regression: asyncRuns.get(runId) was undefined after the fail-fast → TypeError
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask());
    const runner: Runner = {
      run: async () => ({ status: 'accepted' as const, statusUrl: 'u', pollIntervalMs: 1000 }),
    }; // no poll
    const engine = createEngine({ storage, runner, now: () => NOON });

    const run = await engine.triggerTask('task-a');

    expect(run!.status).toBe('failed');
    expect(run!.error).toContain('poll');
    // manual trigger never advances the schedule (slice 2: the poll-less
    // fail-fast records the run on the task but leaves nextRunAt untouched).
    expect((await storage.getTask('task-a'))!.nextRunAt).toEqual(makeTask().nextRunAt);
  });

  it('survives a storage failure in tick (error boundary) and keeps ticking', async () => {
    // regression: tick had no catch — a storage error was an unhandled rejection
    const events: EngineEvent[] = [];
    const failing = new MemoryStorage();
    failing.listDueSchedules = async () => {
      throw new Error('db down');
    };
    const engine = createEngine({
      storage: failing,
      runner: makeRunner().runner,
      now: () => NOON,
      onEvent: (e) => events.push(e),
    });

    await expect(engine.runOnce()).resolves.toBeUndefined(); // must not reject
    expect(events.some((e) => e.type === 'error' && (e as { message: string }).message.includes('db down'))).toBe(true);

    // a healthy storage keeps working on the next tick
    const healthy = new MemoryStorage();
    await seedTask(healthy, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const good = createEngine({ storage: healthy, runner: makeRunner().runner, now: () => NOON });
    await good.runOnce();
    expect([...healthy.runs.values()]).toHaveLength(1);
  });
});

describe('engine — storage error boundary (prod defect 1: MongoNetworkError must not crash the daemon)', () => {
  // books cutover 2026-08-22: a mongo connection drop rejects the in-flight
  // storage op (driver reconnects on its own, but the op that hit the gap
  // throws MongoNetworkError). The interval callbacks are `void fn()` — an
  // unhandled rejection = process crash in Node 24. Every loop must catch and
  // fire an error event instead.

  it('pollOnce survives a throwing storage op (async finish) and fires error', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const accepted = { status: 'accepted' as const, statusUrl: 'http://worker:3000/status/r1', pollIntervalMs: 1000 };
    const { runner } = makeRunner(async () => accepted, async () => ({ status: 'succeeded' } as PollResult));
    const events: EngineEvent[] = [];
    const engine = createEngine({ storage, runner, now: () => NOON, onEvent: (e) => events.push(e) });
    // accepted run sitting in the poll queue
    await engine.runOnce();
    const [run] = [...storage.runs.values()];
    expect(run!.status).toBe('queued');
    // storage.finishRun explodes like a mongo connection drop (driver
    // reconnects on its own, but the op that hit the gap throws)
    storage.finishRun = async () => {
      throw new Error('MongoNetworkError: connection closed');
    };
    // one poll pass — must NOT reject (the daemon's void interval would crash)
    await expect(engine.runPollOnce(new Date(NOON.getTime() + 2000))).resolves.toBeUndefined();
    const err = events.find((e) => e.type === 'error') as Extract<EngineEvent, { type: 'error' }> | undefined;
    expect(err?.type).toBe('error');
    expect(err?.message).toContain('MongoNetworkError');
  });

  it('watchdog reap survives a throwing storage op and fires error', async () => {
    const storage = new MemoryStorage();
    const orig = storage.reapZombieLocks.bind(storage);
    storage.reapZombieLocks = async () => {
      throw new Error('MongoNetworkError: server selection timeout');
    };
    const events: EngineEvent[] = [];
    const engine = createEngine({ storage, runner: makeRunner().runner, now: () => NOON, onEvent: (e) => events.push(e) });
    await expect(engine.runWatchdogOnce(NOON)).resolves.toBeUndefined();
    void orig;
    const err = events.find((e) => e.type === 'error') as Extract<EngineEvent, { type: 'error' }> | undefined;
    expect(err?.type).toBe('error');
    expect(err?.message).toContain('MongoNetworkError');
  });

  it('retention once survives a throwing pruneRuns and fires error', async () => {
    const storage = new MemoryStorage();
    const orig = storage.pruneRuns.bind(storage);
    storage.pruneRuns = async () => {
      throw new Error('MongoNetworkError: connection closed');
    };
    const events: EngineEvent[] = [];
    const engine = createEngine({ storage, runner: makeRunner().runner, now: () => NOON, onEvent: (e) => events.push(e) });
    await expect(engine.runRetentionOnce(NOON)).resolves.toBeUndefined();
    void orig;
    const err = events.find((e) => e.type === 'error') as Extract<EngineEvent, { type: 'error' }> | undefined;
    expect(err?.type).toBe('error');
  });

  it('retention is disabled when retentionMs and temporaryRetentionMs are 0 (prod defect 6: archive must not be pruned)', async () => {
    const storage = new MemoryStorage();
    const pruneCalls: unknown[] = [];
    storage.pruneRuns = async (f) => {
      pruneCalls.push(f);
      return 0;
    };
    const engine = createEngine({
      storage,
      runner: makeRunner().runner,
      now: () => NOON,
      retentionMs: 0,
      temporaryRetentionMs: 0,
    });
    await engine.runRetentionOnce(NOON);
    expect(pruneCalls).toEqual([]); // nothing pruned — archive semantics
  });

  it('retention is disabled when only one class is 0 (the other class still prunes)', async () => {
    const storage = new MemoryStorage();
    const pruneCalls: Array<{ temporary: boolean }> = [];
    storage.pruneRuns = async (f) => {
      pruneCalls.push(f);
      return 0;
    };
    const engine = createEngine({
      storage,
      runner: makeRunner().runner,
      now: () => NOON,
      retentionMs: 0,
      temporaryRetentionMs: 24 * 60 * 60 * 1000,
    });
    await engine.runRetentionOnce(NOON);
    expect(pruneCalls.map((c) => (c as { temporary: boolean }).temporary)).toEqual([true]);
  });
});

describe('engine — watchdog', () => {
  it('reaps zombie locks older than lockTtl, keeping fresh ones', async () => {
    const storage = new MemoryStorage();
    const olderThan: Date[] = [];
    const original = storage.reapZombieScheduleLocks.bind(storage);
    storage.reapZombieScheduleLocks = async (t) => {
      olderThan.push(t);
      return original(t);
    };

    await seedTask(storage, makeTask({ name: 'stale', lockedAt: new Date('2026-08-16T10:00:00Z') }));
    await seedTask(storage, makeTask({ name: 'fresh', lockedAt: new Date('2026-08-16T11:50:00Z') }));
    const engine = createEngine({
      storage,
      runner: makeRunner().runner,
      now: () => NOON,
      lockTtlMs: 30 * 60 * 1000,
    });

    await engine.runWatchdogOnce();

    expect(olderThan).toEqual([new Date('2026-08-16T11:30:00Z')]);
    expect((await storage.getSchedule('stale'))!.lockedAt).toBeNull();
    expect((await storage.getSchedule('stale'))!.failCount).toBe(1);
    expect((await storage.getSchedule('fresh'))!.lockedAt).not.toBeNull();
  });
});

describe('engine — retention', () => {
  const now = new Date('2026-08-16T12:00:00Z');
  const baseRun = {
    taskName: 'task-a',
    runner: 'http',
    startedAt: new Date('2026-08-01T00:00:00Z'),
    finishedAt: null,
    status: 'succeeded' as const,
    data: null,
    result: null,
    error: null,
    progress: null,
    log: null,
    artifacts: null,
    workerRef: null,
    attempt: 1,
    trigger: 'schedule' as const,
    triggeredBy: null,
    scheduleId: null,
    temporary: false,
    retryOf: null,
  };

  it('prunes temporary runs after 24h and regular runs after 30d (two class-specific passes)', async () => {
    const storage = new MemoryStorage();
    const calls: Array<{ olderThan: Date; temporary: boolean }> = [];
    const original = storage.pruneRuns.bind(storage);
    storage.pruneRuns = async (f) => {
      calls.push(f);
      return original(f);
    };

    await storage.createRun({
      ...baseRun,
      id: 'temp-old',
      temporary: true,
      finishedAt: new Date('2026-08-15T11:00:00Z'), // 25h ago → past the 24h temp TTL
    });
    await storage.createRun({
      ...baseRun,
      id: 'reg-old',
      temporary: false,
      finishedAt: new Date('2026-07-10T00:00:00Z'), // > 30d → past the regular TTL
    });
    await storage.createRun({
      ...baseRun,
      id: 'temp-fresh',
      temporary: true,
      finishedAt: new Date('2026-08-16T11:00:00Z'), // 1h ago → kept
    });

    const engine = createEngine({ storage, runner: makeRunner().runner, now: () => now });
    await engine.runRetentionOnce();

    // two class-specific sweeps with the engine's TTL defaults
    expect(calls).toEqual([
      { olderThan: new Date('2026-08-15T12:00:00Z'), temporary: true }, // now - 24h
      { olderThan: new Date('2026-07-17T12:00:00Z'), temporary: false }, // now - 30d
    ]);
    const remaining = (await storage.listRuns()).map((r) => r.id).sort();
    expect(remaining).toEqual(['temp-fresh']);
  });

  it('honours custom retentionMs / temporaryRetentionMs', async () => {
    const storage = new MemoryStorage();
    await storage.createRun({
      ...baseRun,
      id: 'temp-old',
      temporary: true,
      finishedAt: new Date('2026-08-16T09:00:00Z'), // 3h ago → past the 2h temp TTL
    });
    await storage.createRun({
      ...baseRun,
      id: 'reg-fresh',
      temporary: false,
      finishedAt: new Date('2026-08-16T11:00:00Z'),
    });
    const engine = createEngine({
      storage,
      runner: makeRunner().runner,
      now: () => now,
      temporaryRetentionMs: 2 * 60 * 60 * 1000, // 2h
      retentionMs: 10 * 24 * 60 * 60 * 1000, // 10d
    });

    await engine.runRetentionOnce();

    // 3h-old temp run is past the 2h temp TTL; the regular run is far from 10d
    expect((await storage.listRuns()).map((r) => r.id)).toEqual(['reg-fresh']);
  });

  it('fires retention-pruned only when something was actually removed', async () => {
    const storage = new MemoryStorage();
    const events: EngineEvent[] = [];
    const engine = createEngine({ storage, runner: makeRunner().runner, now: () => now, onEvent: (e) => events.push(e) });

    await engine.runRetentionOnce(); // nothing to prune
    expect(events).toEqual([]);

    await storage.createRun({ ...baseRun, id: 'temp-old', temporary: true, finishedAt: new Date('2026-08-15T00:00:00Z') });
    await engine.runRetentionOnce();
    const pruned = events.find((e) => e.type === 'retention-pruned') as Extract<EngineEvent, { type: 'retention-pruned' }>;
    expect(pruned.removed).toBe(1);
  });
});

describe('engine — integration with the real SQLite adapter', () => {
  it('runs a task end-to-end through createSqliteStorage', async () => {
    const storage = createSqliteStorage(new DatabaseSync(':memory:'));
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const { runner, calls } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOON });

    await engine.runOnce();

    expect(calls).toHaveLength(1);
    const t = await storage.getSchedule('task-a');
    expect(t!.lockedAt).toBeNull();
    expect(t!.lastRunAt!.getTime()).toBe(Date.parse('2026-08-16T12:00:00Z'));
    expect(t!.nextRunAt!.getTime()).toBe(Date.parse('2026-08-17T09:00:00Z'));
    expect((await storage.getRun(calls[0]!.runId))!.status).toBe('succeeded');
  });
});

describe('engine — async accepted + poll loop', () => {
  const accepted = { status: 'accepted' as const, statusUrl: 'http://worker:3000/status/r1', pollIntervalMs: 1000 };

  it('marks the run queued with workerRef=statusUrl and keeps the task locked', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const { runner } = makeRunner(async () => accepted);
    const engine = createEngine({ storage, runner, now: () => NOON });

    await engine.runOnce();

    const [run] = [...storage.runs.values()];
    expect(run!.status).toBe('queued');
    expect(run!.workerRef).toBe(accepted.statusUrl);
    expect(run!.finishedAt).toBeNull();
    // task stays claimed until the poll resolves — no double dispatch
    expect((await storage.getSchedule('task-a'))!.lockedAt).not.toBeNull();
  });

  it('fails fast when the runner accepted but has no poll()', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const runner: Runner = { run: async () => accepted }; // no poll
    const engine = createEngine({ storage, runner, now: () => NOON });

    await engine.runOnce();

    const [run] = [...storage.runs.values()];
    expect(run!.status).toBe('failed');
    expect(run!.error).toContain('poll');
    expect((await storage.getSchedule('task-a'))!.lockedAt).toBeNull();
    expect((await storage.getSchedule('task-a'))!.failCount).toBe(1);
  });

  it('applies intermediate poll progress/log without completing the run', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const { runner, pollCalls } = makeRunner(async () => accepted, async () => ({ status: 'running', progress: 50, log: 'halfway' }));
    const engine = createEngine({ storage, runner, now: () => NOON });
    await engine.runOnce();

    await engine.runPollOnce(new Date('2026-08-16T12:00:01Z'));

    expect(pollCalls).toHaveLength(1);
    expect(pollCalls[0]!.statusUrl).toBe(accepted.statusUrl);
    const [run] = [...storage.runs.values()];
    expect(run!.status).toBe('running');
    expect(run!.progress).toBe(50);
    expect(run!.log).toBe('halfway');
    expect(run!.finishedAt).toBeNull();
    expect((await storage.getSchedule('task-a'))!.lockedAt).not.toBeNull();
  });

  it('passes the task to poll() so the runner can carry per-task auth config', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ config: { url: 'http://w/', auth: { apiKey: 'secret-1' } }, nextRunAt: new Date('2026-08-16T11:59:00Z') }),
    );
    const { runner, pollCalls } = makeRunner(async () => accepted);
    const engine = createEngine({ storage, runner, now: () => NOON });
    await engine.runOnce();

    await engine.runPollOnce(new Date('2026-08-16T12:00:01Z'));

    expect(pollCalls).toHaveLength(1);
    expect(pollCalls[0]!.task?.name).toBe('task-a');
    expect(pollCalls[0]!.task?.config.auth).toEqual({ apiKey: 'secret-1' });
  });

  it('respects pollIntervalMs: skips polls until the interval elapses', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const { runner, pollCalls } = makeRunner(
      async () => ({ status: 'accepted' as const, statusUrl: 'u', pollIntervalMs: 5000 }),
      async () => ({ status: 'running' }),
    );
    const engine = createEngine({ storage, runner, now: () => NOON });
    await engine.runOnce();

    await engine.runPollOnce(new Date('2026-08-16T12:00:03Z')); // 3s < 5s
    expect(pollCalls).toHaveLength(0);
    await engine.runPollOnce(new Date('2026-08-16T12:00:06Z')); // 6s ≥ 5s
    expect(pollCalls).toHaveLength(1);
  });

  it('completes the run and unlocks the task on a terminal poll', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const artifacts = [{ kind: 's3' as const, ref: 's3://b/r.pdf', label: null }];
    const { runner, pollCalls } = makeRunner(
      async () => accepted,
      async () => ({ status: 'succeeded' as const, result: { ok: true }, progress: 100, log: 'done', artifacts }),
    );
    const engine = createEngine({ storage, runner, now: () => NOON });
    await engine.runOnce();
    await engine.runPollOnce(new Date('2026-08-16T12:00:01Z'));

    const [run] = [...storage.runs.values()];
    expect(run!.status).toBe('succeeded');
    expect(run!.result).toEqual({ ok: true });
    expect(run!.log).toBe('done');
    expect(run!.artifacts).toEqual(artifacts);
    expect(run!.finishedAt).not.toBeNull();
    // terminal poll unlocks the task and advances the schedule
    const t = await storage.getSchedule('task-a');
    expect(t!.lockedAt).toBeNull();
    expect(t!.failCount).toBe(0);
    expect(t!.nextRunAt!.getTime()).toBe(Date.parse('2026-08-17T09:00:00Z'));
    expect(t!.lastRunAt!.getTime()).toBe(Date.parse('2026-08-16T12:00:00Z'));
    // no further polls after a terminal result
    await engine.runPollOnce(new Date('2026-08-16T12:00:02Z'));
    expect(pollCalls).toHaveLength(1);
  });

  it('records a failed poll as a failed run and bumps failCount', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const { runner } = makeRunner(async () => accepted, async () => ({ status: 'failed', error: 'nope' }));
    const engine = createEngine({ storage, runner, now: () => NOON });
    await engine.runOnce();
    await engine.runPollOnce(new Date('2026-08-16T12:00:01Z'));

    const [run] = [...storage.runs.values()];
    expect(run!.status).toBe('failed');
    expect(run!.error).toBe('nope');
    expect((await storage.getSchedule('task-a'))!.failCount).toBe(1);
    expect((await storage.getSchedule('task-a'))!.lockedAt).toBeNull();
  });

  it('fails the run when poll throws (worker unreachable)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const { runner } = makeRunner(async () => accepted, async () => {
      throw new Error('ECONNREFUSED');
    });
    const engine = createEngine({ storage, runner, now: () => NOON });
    await engine.runOnce();
    await engine.runPollOnce(new Date('2026-08-16T12:00:01Z'));

    const [run] = [...storage.runs.values()];
    expect(run!.status).toBe('failed');
    expect(run!.error).toContain('ECONNREFUSED');
  });

  it('fails the run after pollTimeoutMs without a terminal result', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const { runner, pollCalls } = makeRunner(async () => accepted, async () => ({ status: 'running', progress: 10 }));
    const engine = createEngine({ storage, runner, now: () => NOON, pollTimeoutMs: 5000 });
    await engine.runOnce();

    // still within timeout: poll applies progress
    await engine.runPollOnce(new Date('2026-08-16T12:00:04Z'));
    expect(pollCalls).toHaveLength(1);
    // beyond timeout: no more polling, run fails
    await engine.runPollOnce(new Date('2026-08-16T12:00:10Z'));
    expect(pollCalls).toHaveLength(1);
    const [run] = [...storage.runs.values()];
    expect(run!.status).toBe('failed');
    expect(run!.error).toContain('timeout');
    expect((await storage.getSchedule('task-a'))!.lockedAt).toBeNull();
    expect((await storage.getSchedule('task-a'))!.failCount).toBe(1);
  });

  it('rejects lockHeartbeatMs >= lockTtlMs at engine creation (r7 F2)', () => {
    const storage = new MemoryStorage();
    expect(() =>
      createEngine({ storage, runner: makeRunner().runner, now: () => NOON, lockTtlMs: 10_000, lockHeartbeatMs: 10_000 }),
    ).toThrow(/lockHeartbeatMs/);
    expect(() =>
      createEngine({ storage, runner: makeRunner().runner, now: () => NOON, lockTtlMs: 10_000, lockHeartbeatMs: 30_000 }),
    ).toThrow(/lockHeartbeatMs/);
    // valid: heartbeat strictly below the ttl (async poll ceiling keeps its own margin by test)
    expect(() =>
      createEngine({ storage, runner: makeRunner().runner, now: () => NOON, lockTtlMs: 30_000, lockHeartbeatMs: 10_000 }),
    ).not.toThrow();
  });

  it('default pollTimeout (25 min) fails a hung async run before the lock TTL (30 min) can reap it', async () => {
    // Regression for peer-review: pollTimeoutMs == lockTtlMs (both 30 min) — the
    // watchdog could unlock a live async run right when its poll times out.
    // Defaults must keep a margin so the poll fails the run first.
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const { runner, pollCalls } = makeRunner(async () => accepted, async () => ({ status: 'running' }));
    const engine = createEngine({ storage, runner, now: () => NOON }); // defaults: 25 min poll / 30 min lock
    await engine.runOnce(); // accepted at 12:00:00

    // 24:59 — within the poll timeout: still polling, task still locked
    await engine.runPollOnce(new Date('2026-08-16T12:24:59Z'));
    expect(pollCalls).toHaveLength(1);
    expect((await storage.getSchedule('task-a'))!.lockedAt).not.toBeNull();

    // 25:00 — poll timeout exceeded: run fails and the lock is cleared,
    // before the watchdog (30 min) could ever reap + re-dispatch it
    await engine.runPollOnce(new Date('2026-08-16T12:25:00Z'));
    const [run] = [...storage.runs.values()];
    expect(run!.status).toBe('failed');
    expect(run!.error).toContain('poll timeout');
    expect((await storage.getSchedule('task-a'))!.lockedAt).toBeNull();
  });

  it('honours a per-task timeoutMs ceiling for async runs (positive overrides the global pollTimeoutMs)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ timeoutMs: 5000, nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const { runner, pollCalls } = makeRunner(async () => accepted, async () => ({ status: 'running', progress: 10 }));
    const engine = createEngine({ storage, runner, now: () => NOON }); // global pollTimeoutMs default 25 min
    await engine.runOnce(); // accepted at 12:00:00

    // 4s < 5s: still within the per-task ceiling — poll applies progress
    await engine.runPollOnce(new Date('2026-08-16T12:00:04Z'));
    expect(pollCalls).toHaveLength(1);
    // 10s ≥ 5s: per-task ceiling fires (the global 25-min default never would)
    await engine.runPollOnce(new Date('2026-08-16T12:00:10Z'));
    expect(pollCalls).toHaveLength(1);
    const [run] = [...storage.runs.values()];
    expect(run!.status).toBe('failed');
    expect(run!.error).toContain('run timeout after 5000ms');
    expect((await storage.getSchedule('task-a'))!.lockedAt).toBeNull();
    expect((await storage.getSchedule('task-a'))!.failCount).toBe(1);
  });

  it('timeoutMs: -1 disables the async ceiling — only manual cancel stops the run', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ timeoutMs: -1, nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const { runner, pollCalls } = makeRunner(async () => accepted, async () => ({ status: 'running', progress: 1 }));
    const engine = createEngine({ storage, runner, now: () => NOON, pollTimeoutMs: 5000 }); // global ceiling must not apply
    await engine.runOnce();

    // way past any sane ceiling: run keeps polling, never auto-terminated
    await engine.runPollOnce(new Date('2026-08-16T12:10:00Z'));
    expect(pollCalls).toHaveLength(1);
    const [run] = [...storage.runs.values()];
    expect(run!.status).toBe('running');
    expect(run!.finishedAt).toBeNull();
    expect((await storage.getSchedule('task-a'))!.lockedAt).not.toBeNull();
  });

  it('sends POST /cancel to the worker on poll timeout when a cancelUrl was advertised (#1277)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const events: EngineEvent[] = [];
    const acceptedWithCancel = {
      status: 'accepted' as const,
      statusUrl: 'http://worker:3000/status/r1',
      cancelUrl: 'http://worker:3000/cancel/r1',
      pollIntervalMs: 1000,
    };
    const { runner, cancelCalls } = makeRunner(
      async () => acceptedWithCancel,
      async () => ({ status: 'running', progress: 10 }),
      async () => 200,
    );
    const engine = createEngine({ storage, runner, now: () => NOON, pollTimeoutMs: 5000, onEvent: (e) => events.push(e) });
    await engine.runOnce(); // accepted at 12:00:00

    // 10s > 5s: the global poll ceiling fires → the worker must be told to stop
    await engine.runPollOnce(new Date('2026-08-16T12:00:10Z'));
    const [run] = [...storage.runs.values()];
    expect(run!.status).toBe('failed');
    expect(run!.error).toContain('poll timeout after 5000ms');
    expect(cancelCalls).toEqual([
      {
        runId: run!.id,
        statusUrl: 'http://worker:3000/status/r1',
        task: expect.objectContaining({ name: 'task-a' }),
        cancelUrl: 'http://worker:3000/cancel/r1',
      },
    ]);
    // observability: sent → acked, no failure lines
    const sent = events.find((e) => e.type === 'cancel-sent') as Extract<EngineEvent, { type: 'cancel-sent' }> | undefined;
    const ack = events.find((e) => e.type === 'cancel-ack') as Extract<EngineEvent, { type: 'cancel-ack' }> | undefined;
    expect(sent?.cancelUrl).toBe('http://worker:3000/cancel/r1');
    expect(ack?.status).toBe(200);
    expect(events.some((e) => e.type === 'cancel-failed')).toBe(false);
    expect(events.some((e) => e.type === 'cancel-no-channel')).toBe(false);
  });

  it('sends POST /cancel to the worker on the per-task timeoutMs ceiling when a cancelUrl was advertised (#1277)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ timeoutMs: 5000, nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const events: EngineEvent[] = [];
    const acceptedWithCancel = {
      status: 'accepted' as const,
      statusUrl: 'http://worker:3000/status/r1',
      cancelUrl: 'http://worker:3000/cancel/r1',
      pollIntervalMs: 1000,
    };
    const { runner, cancelCalls } = makeRunner(
      async () => acceptedWithCancel,
      async () => ({ status: 'running', progress: 10 }),
      async () => 200,
    );
    const engine = createEngine({ storage, runner, now: () => NOON, onEvent: (e) => events.push(e) });
    await engine.runOnce(); // accepted at 12:00:00

    // 10s ≥ 5s per-task ceiling → the worker must be told to stop
    await engine.runPollOnce(new Date('2026-08-16T12:00:10Z'));
    const [run] = [...storage.runs.values()];
    expect(run!.status).toBe('failed');
    expect(run!.error).toContain('run timeout after 5000ms');
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0]!.cancelUrl).toBe('http://worker:3000/cancel/r1');
    expect(events.some((e) => e.type === 'cancel-sent')).toBe(true);
    expect(events.some((e) => e.type === 'cancel-ack')).toBe(true);
    expect(events.some((e) => e.type === 'cancel-failed')).toBe(false);
  });

  it('does not call runner.cancel on poll timeout without a cancelUrl (legacy stop-polling verdict unchanged)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const events: EngineEvent[] = [];
    const { runner, cancelCalls } = makeRunner(
      async () => accepted,
      async () => ({ status: 'running', progress: 10 }),
      async () => 200,
    );
    const engine = createEngine({ storage, runner, now: () => NOON, pollTimeoutMs: 5000, onEvent: (e) => events.push(e) });
    await engine.runOnce();

    await engine.runPollOnce(new Date('2026-08-16T12:00:10Z'));
    const [run] = [...storage.runs.values()];
    expect(run!.status).toBe('failed');
    expect(run!.error).toContain('poll timeout after 5000ms');
    expect(cancelCalls).toHaveLength(0); // no channel → worker left to finish on its own
    expect(events.some((e) => e.type === 'cancel-no-channel')).toBe(true);
    expect(events.some((e) => e.type === 'cancel-sent')).toBe(false);
  });

  it('records a failed cancel signal on poll timeout in the run error — the worker may still be running (#1277)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const events: EngineEvent[] = [];
    const acceptedWithCancel = {
      status: 'accepted' as const,
      statusUrl: 'http://worker:3000/status/r1',
      cancelUrl: 'http://worker:3000/cancel/r1',
      pollIntervalMs: 1000,
    };
    const { runner } = makeRunner(
      async () => acceptedWithCancel,
      async () => ({ status: 'running', progress: 10 }),
      async () => {
        throw new Error('ECONNREFUSED');
      },
    );
    const engine = createEngine({ storage, runner, now: () => NOON, pollTimeoutMs: 5000, onEvent: (e) => events.push(e) });
    await engine.runOnce();

    await engine.runPollOnce(new Date('2026-08-16T12:00:10Z'));
    const [run] = [...storage.runs.values()];
    expect(run!.status).toBe('failed');
    expect(run!.error).toContain('poll timeout after 5000ms');
    expect(run!.error).toContain('cancel signal failed: ECONNREFUSED');
    const failed = events.find((e) => e.type === 'cancel-failed') as Extract<EngineEvent, { type: 'cancel-failed' }> | undefined;
    expect(failed?.error).toBe('ECONNREFUSED');
    expect(events.some((e) => e.type === 'cancel-ack')).toBe(false);
  });

  it('does not double-POST /cancel when user cancel races the poll timeout (#1277 review guard)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    let releaseCancel!: () => void;
    const cancelGate = new Promise<void>((r) => (releaseCancel = r));
    const acceptedWithCancel = {
      status: 'accepted' as const,
      statusUrl: 'http://worker:3000/status/r1',
      cancelUrl: 'http://worker:3000/cancel/r1',
      pollIntervalMs: 1000,
    };
    const { runner, cancelCalls } = makeRunner(
      async () => acceptedWithCancel,
      async () => ({ status: 'running', progress: 10 }),
      async () => {
        await cancelGate; // hold the signal in flight — the timeout branch fires meanwhile
        return 200;
      },
    );
    const engine = createEngine({ storage, runner, now: () => NOON, pollTimeoutMs: 5000 });
    await engine.runOnce(); // accepted at 12:00:00
    const run = [...storage.runs.values()][0]!;

    const cancelP = engine.cancelRun(run.id); // user cancel → signal in flight (cancelGate held)
    const pollP = engine.runPollOnce(new Date('2026-08-16T12:00:10Z')); // timeout fires while the signal is pending
    releaseCancel();
    await Promise.all([cancelP, pollP]);

    expect(cancelCalls).toHaveLength(1); // one POST /cancel, not two
    const final = await storage.getRun(run.id);
    expect(final!.status).toBe('cancelled'); // user cancel won the race; timeout must not overwrite it
  });

  it('forces a hanging sync run to fail when task.timeoutMs elapses', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ timeoutMs: 50, nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const { runner } = makeRunner(async (_t, _id, _at, hooks) => {
      await new Promise((_, reject) => {
        hooks?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
      return { status: 'succeeded' };
    });
    const engine = createEngine({ storage, runner, now: () => NOON });

    const started = Date.now();
    await engine.runOnce();
    expect(Date.now() - started).toBeLessThan(1000); // aborted at ~50ms, not left hanging

    const [run] = [...storage.runs.values()];
    expect(run!.status).toBe('failed');
    expect(run!.error).toContain('run timeout after 50ms');
    expect((await storage.getSchedule('task-a'))!.lockedAt).toBeNull();
    expect((await storage.getSchedule('task-a'))!.failCount).toBe(1);
  });

  it('timeoutMs: -1 lets a sync run finish on its own (no deadline, no abort)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ timeoutMs: -1, nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    let aborted = false;
    const { runner } = makeRunner(async (_t, _id, _at, hooks) => {
      hooks?.signal?.addEventListener('abort', () => {
        aborted = true;
      });
      return { status: 'succeeded', result: { slow: true } };
    });
    const engine = createEngine({ storage, runner, now: () => NOON });

    await engine.runOnce();

    expect(aborted).toBe(false);
    const [run] = [...storage.runs.values()];
    expect(run!.status).toBe('succeeded');
  });

  it('triggerTask with an async runner keeps the schedule untouched', async () => {
    const storage = new MemoryStorage();
    const task = makeTask({ nextRunAt: new Date('2026-08-17T09:00:00Z') });
    await seedTask(storage, task);
    const { runner } = makeRunner(async () => accepted, async () => ({ status: 'succeeded' }));
    const engine = createEngine({ storage, runner, now: () => NOON });

    const run = await engine.triggerTask('task-a');
    expect(run!.status).toBe('queued');

    await engine.runPollOnce(new Date('2026-08-16T12:00:01Z'));

    const t = await storage.getSchedule('task-a');
    expect(t!.nextRunAt).toEqual(task.nextRunAt); // schedule untouched
    expect(t!.lockedAt).toBeNull();
    expect(t!.failCount).toBe(0);
  });
});

describe('engine — onRunFinal hook', () => {
  const accepted = { status: 'accepted' as const, statusUrl: 'http://worker:3000/status/r1', pollIntervalMs: 1000 };

  it('fires on a sync succeeded run with the finished record', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const finals: string[] = [];
    const engine = createEngine({
      storage,
      runner: { run: async () => ({ status: 'succeeded', result: { ok: true } }) },
      now: () => NOON,
      onRunFinal: async (run) => { finals.push(`${run.status}:${(run.result as { ok?: boolean } | null)?.ok}`); },
    });

    await engine.runOnce();

    expect(finals).toEqual(['succeeded:true']);
  });

  it('fires on a sync failed run (throwing runner)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const finals: string[] = [];
    const engine = createEngine({
      storage,
      runner: { run: async () => { throw new Error('boom'); } },
      now: () => NOON,
      onRunFinal: async (run) => { finals.push(`${run.status}:${run.error}`); },
    });

    await engine.runOnce();

    expect(finals).toEqual(['failed:boom']);
  });

  it('does NOT re-read storage after finishRun — the final alert survives a post-finish read failure (task:1390)', async () => {
    // The reported symptom: «run.failed в БД, алерт молчит». The alert must
    // not depend on a SECOND storage read after the terminal write — a storage
    // hiccup in that window (books/mongo incident class 2026-08-24) loses the
    // alert while the run IS failed. recordFinish snapshots the record BEFORE
    // finishRun and passes it to onRunFinal directly.
    const inner = new MemoryStorage();
    let finished = false;
    let postFinishReads = 0;
    const storage = new Proxy(inner, {
      get(target, prop, receiver) {
        const v = (target as unknown as Record<string, unknown>)[prop as string];
        if (prop === 'finishRun') {
          return async (...args: unknown[]) => {
            const r = await (v as (...x: unknown[]) => Promise<unknown>).apply(target, args);
            finished = true;
            return r;
          };
        }
        if (prop === 'getRun') {
          return async (...args: unknown[]) => {
            if (finished) postFinishReads++;
            return (v as (...x: unknown[]) => Promise<unknown>).apply(target, args);
          };
        }
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const finals: string[] = [];
    const engine = createEngine({
      storage,
      runner: { run: async () => { throw new Error('boom'); } },
      now: () => NOON,
      onRunFinal: async (run) => { finals.push(`${run.status}:${run.error}`); },
    });

    await engine.runOnce();

    expect(finals).toEqual(['failed:boom']); // the alert still fired
    expect(postFinishReads).toBe(0); // ...without re-reading storage
  });

  it('fires on async terminal (accepted → poll succeeded)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const finals: string[] = [];
    const engine = createEngine({
      storage,
      runner: makeRunner(async () => accepted, async () => ({ status: 'succeeded' })).runner,
      now: () => NOON,
      onRunFinal: async (run) => { finals.push(run.status); },
    });
    await engine.runOnce();
    await engine.runPollOnce(new Date('2026-08-16T12:00:01Z'));

    expect(finals).toEqual(['succeeded']);
  });

  it('fires on async terminal (accepted → poll failed) — the http-runner alert path (task:1390)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const finals: string[] = [];
    const engine = createEngine({
      storage,
      runner: makeRunner(async () => accepted, async () => ({ status: 'failed', error: 'worker reported failure' })).runner,
      now: () => NOON,
      onRunFinal: async (run) => { finals.push(`${run.status}:${run.error}`); },
    });
    await engine.runOnce();
    await engine.runPollOnce(new Date('2026-08-16T12:00:01Z'));

    expect(finals).toEqual(['failed:worker reported failure']);
  });

  it('fires on accepted-without-poll fail-fast', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const finals: string[] = [];
    const engine = createEngine({
      storage,
      runner: { run: async () => accepted },
      now: () => NOON,
      onRunFinal: async (run) => { finals.push(`${run.status}:${run.error}`); },
    });

    await engine.runOnce();

    expect(finals.length).toBe(1);
    expect(finals[0]).toContain('failed');
    expect(finals[0]).toContain('poll');
  });
});

describe('engine — onEvent (engine-events level 3)', () => {
  const accepted = { status: 'accepted' as const, statusUrl: 'http://worker:3000/status/r1', pollIntervalMs: 1000 };

  it('is silent by default — no observer, engine behaves exactly as before', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const engine = createEngine({ storage, runner: makeRunner().runner, now: () => NOON });

    await expect(engine.runOnce()).resolves.toBeUndefined();
    const [run] = [...storage.runs.values()];
    expect(run!.status).toBe('succeeded');
  });

  it('fires tick → claim → dispatch → run-succeeded for a due task', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const events: EngineEvent[] = [];
    const engine = createEngine({ storage, runner: makeRunner().runner, now: () => NOON, onEvent: (e) => events.push(e) });

    await engine.runOnce();

    expect(events.map((e) => e.type)).toEqual(['tick', 'claim', 'dispatch', 'run-succeeded']);
    const claim = events[1] as Extract<EngineEvent, { type: 'claim' }>;
    expect(claim.taskName).toBe('task-a');
    expect(claim.attempt).toBe(1);
    expect(claim.runId).toBeTruthy();
    const dispatch = events[2] as Extract<EngineEvent, { type: 'dispatch' }>;
    expect(dispatch.runner).toBe('http');
    const done = events[3] as Extract<EngineEvent, { type: 'run-succeeded' }>;
    expect(done.attempt).toBe(1);
    expect(done.runId).toBe(claim.runId); // same run through the lifecycle
  });

  it('does not fire tick when nothing is due (no 1s-cadence noise)', async () => {
    const storage = new MemoryStorage();
    const events: EngineEvent[] = [];
    const engine = createEngine({ storage, runner: makeRunner().runner, now: () => NOON, onEvent: (e) => events.push(e) });

    await engine.runOnce();

    expect(events).toEqual([]);
  });

  it('fires run-failed + retry-scheduled on a failure with retries left; only run-failed on the exhausted attempt', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ retry: { maxAttempts: 2, backoffMs: 60_000 }, nextRunAt: new Date('2026-08-16T11:59:00Z') }),
    );
    const events: EngineEvent[] = [];
    const engine = createEngine({
      storage,
      runner: makeRunner(async () => ({ status: 'failed', error: 'boom' })).runner,
      now: () => NOON,
      onEvent: (e) => events.push(e),
    });

    await engine.runOnce(); // attempt 1 fails → retry at 12:01
    await engine.runOnce(new Date('2026-08-16T12:01:00Z')); // attempt 2 fails → exhausted

    const lifecycle = events.filter((e) => e.type !== 'tick').map((e) => e.type);
    expect(lifecycle).toEqual(['claim', 'dispatch', 'run-failed', 'retry-scheduled', 'claim', 'dispatch', 'run-failed']);
    const retry = events.find((e) => e.type === 'retry-scheduled') as Extract<EngineEvent, { type: 'retry-scheduled' }>;
    expect(retry.attempt).toBe(1);
    expect(retry.backoffMs).toBe(60_000);
    expect(retry.nextRunAt.getTime()).toBe(Date.parse('2026-08-16T12:01:00Z'));
  });

  it('fires run-cancelled for a cancelled outcome', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const events: EngineEvent[] = [];
    const engine = createEngine({
      storage,
      runner: makeRunner(async () => ({ status: 'cancelled', error: 'timeout after SIGKILL' })).runner,
      now: () => NOON,
      onEvent: (e) => events.push(e),
    });

    await engine.runOnce();

    const cancelled = events.find((e) => e.type === 'run-cancelled') as Extract<EngineEvent, { type: 'run-cancelled' }>;
    expect(cancelled.error).toBe('timeout after SIGKILL');
  });

  it('fires poll events with status/progress for queued async runs', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const events: EngineEvent[] = [];
    const { runner } = makeRunner(async () => accepted, async () => ({ status: 'running', progress: 50 }));
    const engine = createEngine({ storage, runner, now: () => NOON, onEvent: (e) => events.push(e) });
    await engine.runOnce();

    await engine.runPollOnce(new Date('2026-08-16T12:00:01Z'));

    const polls = events.filter((e) => e.type === 'poll');
    expect(polls).toHaveLength(1);
    const p = polls[0] as Extract<EngineEvent, { type: 'poll' }>;
    expect(p.taskName).toBe('task-a');
    expect(p.status).toBe('running');
    expect(p.progress).toBe(50);
  });

  it('fires zombie-reaped only when locks were actually reaped', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ name: 'stale', lockedAt: new Date('2026-08-16T10:00:00Z') }));
    const events: EngineEvent[] = [];
    const engine = createEngine({ storage, runner: makeRunner().runner, now: () => NOON, onEvent: (e) => events.push(e) });

    await engine.runWatchdogOnce();
    expect(events.filter((e) => e.type === 'zombie-reaped')).toHaveLength(1);

    // second pass: nothing left to reap → no event
    await engine.runWatchdogOnce();
    expect(events.filter((e) => e.type === 'zombie-reaped')).toHaveLength(1);
  });

  it('swallows observer errors — a throwing onEvent never breaks the engine', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const engine = createEngine({
      storage,
      runner: makeRunner().runner,
      now: () => NOON,
      onEvent: () => { throw new Error('logger exploded'); },
    });

    await expect(engine.runOnce()).resolves.toBeUndefined();
    const [run] = [...storage.runs.values()];
    expect(run!.status).toBe('succeeded');
    expect((await storage.getSchedule('task-a'))!.lockedAt).toBeNull();
  });

  it('fires dispatch + outcome for a manual triggerTask (no claim)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-17T09:00:00Z') }));
    const events: EngineEvent[] = [];
    const engine = createEngine({ storage, runner: makeRunner().runner, now: () => NOON, onEvent: (e) => events.push(e) });

    await engine.triggerTask('task-a');

    expect(events.map((e) => e.type)).toEqual(['dispatch', 'run-succeeded']);
  });
});

describe('engine — pollOnce reentrancy (peer-review regression)', () => {
  const accepted = { status: 'accepted' as const, statusUrl: 'http://worker:3000/status/r1', pollIntervalMs: 1000 };

  it('never double-finishes when a slow poll overlaps the next pollOnce tick', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    let resolvePoll!: (p: PollResult) => void;
    const gate = new Promise<PollResult>((res) => {
      resolvePoll = res;
    });
    const { runner, pollCalls } = makeRunner(async () => accepted, async () => gate);
    const engine = createEngine({ storage, runner, now: () => NOON });
    await engine.runOnce(); // accepted → queued

    const p1 = engine.runPollOnce(new Date('2026-08-16T12:00:01Z')); // starts, awaits the gated poll
    const p2 = engine.runPollOnce(new Date('2026-08-16T12:00:02Z')); // must no-op (reentrancy guard)
    resolvePoll({ status: 'succeeded' });
    await Promise.all([p1, p2]);

    expect(pollCalls).toHaveLength(1); // no re-poll from the overlapping tick
    expect([...storage.runs.values()].filter((r) => r.status === 'succeeded')).toHaveLength(1);
    const t = await storage.getSchedule('task-a');
    expect(t!.lockedAt).toBeNull();
    expect(t!.failCount).toBe(0); // no double completeTask
  });
});

describe('engine — lock heartbeat (long sync runs > lockTtl)', () => {
  it('keeps a long sync run claimed past lockTtl (heartbeat refreshes lockedAt; watchdog never reaps it)', async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));

      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const startedP = new Promise<void>((r) => (started = r));

      const engine = createEngine({
        storage,
        runner: {
          run: async () => {
            started();
            await gate; // long sync run — blocks well past lockTtl
            return { status: 'succeeded' };
          },
        },
        lockTtlMs: 6_000,       // watchdog would reap a 6 s-old lock
        lockHeartbeatMs: 2_000, // heartbeat refreshes every 2 s
      });
      vi.setSystemTime(new Date('2026-08-16T12:00:00Z'));

      const running = engine.runOnce(); // claims at 12:00:00, runner blocks on gate
      await startedP; // runner in flight → heartbeat interval armed

      // 7 s of wall time: heartbeat fires at 2 s / 4 s / 6 s → lockedAt stays fresh.
      await vi.advanceTimersByTimeAsync(7_000);

      // Watchdog pass at 12:00:07 (olderThan = 12:00:01): without the heartbeat
      // the 12:00:00 claim would be reaped; with it the lock sits at 12:00:06.
      await engine.runWatchdogOnce();
      const mid = await storage.getSchedule('task-a');
      expect(mid!.lockedAt).toEqual(new Date('2026-08-16T12:00:06Z'));
      expect(mid!.failCount).toBe(0);

      release();
      await running; // run finishes

      const done = await storage.getSchedule('task-a');
      expect(done!.lockedAt).toBeNull(); // lock cleared on finish
      expect(done!.failCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('engine — startup recovery (recoverOrphanRuns)', () => {
  const orphan = {
    id: 'o1',
    taskName: 'a',
    runner: 'http' as const,
    startedAt: new Date('2026-08-16T11:50:00Z'),
    finishedAt: null as Date | null,
    status: 'running' as const,
    data: null,
    result: null,
    error: null,
    progress: null,
    log: null,
    artifacts: null,
    workerRef: null,
    attempt: 1,
    trigger: 'schedule' as const,
    triggeredBy: null,
    scheduleId: null,
    temporary: false,
    retryOf: null,
  };

  it('cancels orphaned running/queued runs and releases every lock; no failCount bump', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ name: 'a', lockedAt: new Date('2026-08-16T11:50:00Z') }));
    await seedTask(storage, makeTask({ name: 'free' }));
    await storage.createRun(orphan);
    await storage.createRun({ ...orphan, id: 'o2', status: 'queued' });
    await storage.createRun({ ...orphan, id: 'done', status: 'succeeded', finishedAt: new Date('2026-08-16T11:00:00Z') });

    const events: EngineEvent[] = [];
    const engine = createEngine({ storage, runner: makeRunner().runner, now: () => NOON, onEvent: (e) => events.push(e) });

    expect(await engine.recoverOrphanRuns()).toBe(2);
    expect((await storage.getRun('o1'))!.status).toBe('cancelled');
    expect((await storage.getRun('o1'))!.finishedAt).not.toBeNull();
    expect((await storage.getRun('o2'))!.status).toBe('cancelled');
    expect((await storage.getRun('done'))!.status).toBe('succeeded'); // terminal runs untouched
    expect((await storage.getSchedule('a'))!.lockedAt).toBeNull(); // lock released immediately
    expect((await storage.getSchedule('a'))!.failCount).toBe(0); // infrastructure interruption, not a task failure
    expect(events).toContainEqual({ type: 'recovered-orphans', count: 2, clearedLocks: 2 });
  });

  it('is a no-op when nothing is orphaned', async () => {
    const storage = new MemoryStorage();
    const events: EngineEvent[] = [];
    const engine = createEngine({ storage, runner: makeRunner().runner, now: () => NOON, onEvent: (e) => events.push(e) });
    expect(await engine.recoverOrphanRuns()).toBe(0);
    expect(events).toHaveLength(0);
  });
});

describe('engine — cancelRun', () => {
  it('returns null for an unknown run', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine({ storage, runner: makeRunner().runner, now: () => NOON });
    expect(await engine.cancelRun('nope')).toBeNull();
  });

  it('cancels a queued async run: removed from the poll queue, schedule advanced, lock released', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const { runner } = makeRunner(async () => ({
      status: 'accepted' as const,
      statusUrl: 'http://worker:3000/status/r1',
      pollIntervalMs: 1000,
    }));
    const engine = createEngine({ storage, runner, now: () => NOON });
    await engine.runOnce(); // accepted → queued
    const run = [...storage.runs.values()][0]!;
    expect(run.status).toBe('queued');
    expect((await storage.getSchedule('task-a'))!.lockedAt).not.toBeNull();

    const cancelled = await engine.cancelRun(run.id);
    expect(cancelled!.status).toBe('cancelled');
    expect(cancelled!.error).toBe('cancelled by user');
    expect(cancelled!.finishedAt).not.toBeNull();
    // schedule advanced + lock released — the poll queue entry is gone (no re-poll)
    expect((await storage.getSchedule('task-a'))!.lockedAt).toBeNull();
    expect((await storage.getSchedule('task-a'))!.nextRunAt).toEqual(new Date('2026-08-17T09:00:00Z'));
    await engine.runPollOnce(new Date('2026-08-16T12:00:30Z'));
    expect((await storage.getRun(run.id))!.status).toBe('cancelled'); // still cancelled, no double-finish
  });

  it('sends the cancel signal to the worker when the accepted envelope advertised a cancelUrl', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const events: EngineEvent[] = [];
    const { runner, cancelCalls } = makeRunner(
      async () => ({
        status: 'accepted' as const,
        statusUrl: 'http://worker:3000/status/r1',
        cancelUrl: 'http://worker:3000/cancel/r1',
        pollIntervalMs: 1000,
      }),
      undefined,
      async () => 200,
    );
    const engine = createEngine({ storage, runner, now: () => NOON, onEvent: (e) => events.push(e) });
    await engine.runOnce(); // accepted → queued
    const run = [...storage.runs.values()][0]!;

    const cancelled = await engine.cancelRun(run.id);
    expect(cancelled!.status).toBe('cancelled');
    expect(cancelled!.error).toBe('cancelled by user');
    // the worker was told to stop BEFORE the run was finished cancelled
    expect(cancelCalls).toEqual([
      {
        runId: run.id,
        statusUrl: 'http://worker:3000/status/r1',
        task: expect.objectContaining({ name: 'task-a' }),
        cancelUrl: 'http://worker:3000/cancel/r1',
      },
    ]);
    // observability: sent → acked (status 200), no failure lines
    const sent = events.find((e) => e.type === 'cancel-sent') as Extract<EngineEvent, { type: 'cancel-sent' }> | undefined;
    const ack = events.find((e) => e.type === 'cancel-ack') as Extract<EngineEvent, { type: 'cancel-ack' }> | undefined;
    expect(sent?.cancelUrl).toBe('http://worker:3000/cancel/r1');
    expect(ack?.status).toBe(200);
    expect(events.some((e) => e.type === 'cancel-failed')).toBe(false);
    expect(events.some((e) => e.type === 'cancel-no-channel')).toBe(false);
  });

  it('does not call runner.cancel when the envelope has no cancelUrl (legacy stop-polling)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const events: EngineEvent[] = [];
    const { runner, cancelCalls } = makeRunner(async () => ({
      status: 'accepted' as const,
      statusUrl: 'http://worker:3000/status/r1',
      pollIntervalMs: 1000,
    }));
    const engine = createEngine({ storage, runner, now: () => NOON, onEvent: (e) => events.push(e) });
    await engine.runOnce();
    const run = [...storage.runs.values()][0]!;

    const cancelled = await engine.cancelRun(run.id);
    expect(cancelled!.status).toBe('cancelled');
    expect(cancelled!.error).toBe('cancelled by user');
    expect(cancelCalls).toHaveLength(0); // no channel → worker left to finish on its own
    // observability: the operator sees WHY nothing was sent
    expect(events.some((e) => e.type === 'cancel-no-channel')).toBe(true);
    expect(events.some((e) => e.type === 'cancel-sent')).toBe(false);
  });

  it('records a failed cancel signal in the run error — the worker may still be running', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const events: EngineEvent[] = [];
    const { runner } = makeRunner(
      async () => ({
        status: 'accepted' as const,
        statusUrl: 'http://worker:3000/status/r1',
        cancelUrl: 'http://worker:3000/cancel/r1',
        pollIntervalMs: 1000,
      }),
      undefined,
      async () => {
        throw new Error('ECONNREFUSED');
      },
    );
    const engine = createEngine({ storage, runner, now: () => NOON, onEvent: (e) => events.push(e) });
    await engine.runOnce();
    const run = [...storage.runs.values()][0]!;

    const cancelled = await engine.cancelRun(run.id);
    expect(cancelled!.status).toBe('cancelled');
    expect(cancelled!.error).toContain('cancel signal failed: ECONNREFUSED');
    // observability: sent then failed with the raw reason
    const failed = events.find((e) => e.type === 'cancel-failed') as Extract<EngineEvent, { type: 'cancel-failed' }> | undefined;
    expect(failed?.error).toBe('ECONNREFUSED');
    expect(events.some((e) => e.type === 'cancel-ack')).toBe(false);
  });

  it('cancels a running sync run: aborts the runner via hooks.signal, awaits completion, run becomes cancelled', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const runner: Runner = {
      run: (_task, _runId, _at, hooks) =>
        new Promise((_resolve, reject) => {
          started();
          hooks?.signal?.addEventListener('abort', () => {
            const e = new Error('cancelled by user');
            e.name = 'AbortError';
            reject(e);
          });
        }),
    };
    const engine = createEngine({ storage, runner, now: () => NOON });

    const running = engine.runOnce();
    await startedP;
    const run = [...storage.runs.values()][0]!;
    expect(run.status).toBe('running');

    const cancelled = await engine.cancelRun(run.id);
    expect(cancelled!.status).toBe('cancelled'); // cancelRun waits for the runner to actually stop
    expect(cancelled!.error).toBe('cancelled by user');
    expect((await storage.getSchedule('task-a'))!.lockedAt).toBeNull();
    await running; // the tick completes cleanly
  });

  it('cancels a MANUALLY triggered sync run and returns the terminal record (no stale running snapshot)', async () => {
    // Live-gate finding (phase-2 docker contour): the manual dispatch paths
    // resolved the cancel-registry promise in `finally`, BEFORE the terminal
    // write — cancelRun then read a pre-cancellation snapshot, so bulk cancel
    // reported a genuinely cancelled run as `not-cancellable` (and
    // POST /runs/:id/cancel answered with status=running).
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask());
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const runner: Runner = {
      run: (_task, _runId, _at, hooks) =>
        new Promise((_resolve, reject) => {
          started();
          hooks?.signal?.addEventListener('abort', () => {
            const e = new Error('cancelled by user');
            e.name = 'AbortError';
            reject(e);
          });
        }),
    };
    // `onRunFinal` mirrors the daemon with alerts wired: the terminal hook reads
    // storage BEFORE finishRun, which is what orders cancelRun's read ahead of
    // the cancellation write. Without the hook the race stays hidden.
    const engine = createEngine({ storage, runner, now: () => NOON, onRunFinal: async () => {} });

    const trigger = engine.triggerTask('task-a');
    await startedP;
    const run = [...storage.runs.values()][0]!;
    expect(run.trigger).toBe('manual');
    expect(run.status).toBe('running');

    const cancelled = await engine.cancelRun(run.id);
    expect(cancelled!.status).toBe('cancelled'); // the caller reads THIS record — it must be terminal
    expect(cancelled!.error).toBe('cancelled by user');
    expect((await storage.getRun(run.id))!.status).toBe('cancelled');
    await trigger; // the manual dispatch completes cleanly
  });

  it('returns a terminal run unchanged (the caller decides — 409)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask());
    await storage.createRun({
      id: 'r1',
      taskName: 'task-a',
      runner: 'http',
      startedAt: new Date('2026-08-16T09:00:00Z'),
      finishedAt: new Date('2026-08-16T09:05:00Z'),
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
      temporary: false,
      retryOf: null,
    });
    const engine = createEngine({ storage, runner: makeRunner().runner, now: () => NOON });
    const run = await engine.cancelRun('r1');
    expect(run!.status).toBe('succeeded');
    expect((await storage.getRun('r1'))!.status).toBe('succeeded');
  });
});

describe('engine — missed-slot detection', () => {
  it('emits missed-slot when a schedule dispatches beyond the grace window', async () => {
    const storage = new MemoryStorage();
    await seedTask(
      storage,
      makeTask({ nextRunAt: new Date('2026-08-16T03:00:00Z'), lastRunAt: new Date('2026-08-15T09:00:00Z') }),
    );
    const events: EngineEvent[] = [];
    const engine = createEngine({
      storage,
      runner: makeRunner().runner,
      now: () => NOON,
      onEvent: (e) => events.push(e),
    });

    await engine.runOnce();

    const missed = events.filter((e) => e.type === 'missed-slot');
    expect(missed).toHaveLength(1);
    const m = missed[0] as Extract<EngineEvent, { type: 'missed-slot' }>;
    expect(m.taskName).toBe('task-a');
    expect(m.scheduledAt).toEqual(new Date('2026-08-16T03:00:00Z'));
    expect(m.delayMs).toBe(9 * 3600 * 1000);
  });

  it('does not emit missed-slot for a dispatch within the grace window', async () => {
    const storage = new MemoryStorage();
    await seedTask(
      storage,
      makeTask({
        nextRunAt: new Date('2026-08-16T11:59:30Z'),
        lastRunAt: new Date('2026-08-15T09:00:00Z'),
      }),
    );
    const events: EngineEvent[] = [];
    const engine = createEngine({
      storage,
      runner: makeRunner().runner,
      now: () => NOON,
      onEvent: (e) => events.push(e),
    });

    await engine.runOnce();

    expect(events.filter((e) => e.type === 'missed-slot')).toHaveLength(0);
  });

  it('does not emit missed-slot for a fresh schedule (catch-up on creation is not a miss)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T03:00:00Z') }));
    const events: EngineEvent[] = [];
    const { runner, calls } = makeRunner();
    const engine = createEngine({
      storage,
      runner,
      now: () => NOON,
      onEvent: (e) => events.push(e),
    });

    await engine.runOnce();

    expect(calls).toHaveLength(1); // catch-up run fires
    expect(events.filter((e) => e.type === 'missed-slot')).toHaveLength(0);
  });

  it('honours a custom missedSlotGraceMs', async () => {
    const storage = new MemoryStorage();
    await seedTask(
      storage,
      makeTask({
        nextRunAt: new Date('2026-08-16T11:59:30Z'),
        lastRunAt: new Date('2026-08-15T09:00:00Z'),
      }),
    );
    const events: EngineEvent[] = [];
    const engine = createEngine({
      storage,
      runner: makeRunner().runner,
      now: () => NOON,
      missedSlotGraceMs: 10_000,
      onEvent: (e) => events.push(e),
    });

    await engine.runOnce();

    const missed = events.filter((e) => e.type === 'missed-slot');
    expect(missed).toHaveLength(1);
  });
});

describe('engine — onRunFinal streak context (R1 alerts)', () => {
  it('reports consecutive terminal failures and re-arms after a success', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask());
    let mode: 'fail' | 'ok' | 'cancelled' = 'fail';
    const { runner } = makeRunner(async () =>
      mode === 'fail' ? { status: 'failed', error: 'boom' } : mode === 'ok' ? { status: 'succeeded' } : { status: 'cancelled', error: 'user' },
    );
    const contexts: number[] = [];
    const engine = createEngine({
      storage,
      runner,
      now: () => NOON,
      onRunFinal: (_run, context) => { contexts.push(context.previousFailures); },
    });

    await engine.triggerTask('task-a'); // failure 1 — nothing before it
    await engine.triggerTask('task-a'); // failure 2 — one before it
    await engine.triggerTask('task-a'); // failure 3 — two before it
    mode = 'cancelled';
    await engine.triggerTask('task-a'); // a cancel neither counts nor resets
    mode = 'ok';
    await engine.triggerTask('task-a'); // success breaks the streak of three
    mode = 'fail';
    await engine.triggerTask('task-a'); // a fresh incident starts from zero

    // 0,1,2 → the three failures; 3 → the cancel reports the open streak and
    // leaves it open; 3 → the success reports the streak it broke; 0 → re-armed.
    expect(contexts).toEqual([0, 1, 2, 3, 3, 0]);
  });

  it('counts only the terminal failure of a retry chain (a retry-pending failure is not an incident)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ retry: { maxAttempts: 2, backoffMs: 60_000 }, nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const { runner } = makeRunner(async () => ({ status: 'failed', error: 'boom' }));
    const contexts: number[] = [];
    const engine = createEngine({
      storage,
      runner,
      now: () => NOON,
      onRunFinal: (_run, context) => { contexts.push(context.previousFailures); },
    });

    await engine.runOnce(); // attempt 1 — retry pending, no terminal hook, streak untouched
    await engine.runOnce(new Date('2026-08-16T12:01:00Z')); // attempt 2 — exhausted, the incident

    expect(contexts).toEqual([0]);
  });

  it('hands the snapshot taken BEFORE the terminal write (the run in flight is not counted)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ nextRunAt: new Date('2026-08-16T11:59:00Z') }));
    const { runner } = makeRunner(async () => ({ status: 'failed', error: 'boom' }));
    const contexts: number[] = [];
    const engine = createEngine({
      storage,
      runner,
      now: () => NOON,
      onRunFinal: (_run, context) => { contexts.push(context.previousFailures); },
    });

    await engine.runOnce();
    expect(contexts).toEqual([0]); // not 1 — the counter is read before the finish write

    await engine.runOnce(new Date('2026-08-17T09:00:00Z'));
    expect(contexts).toEqual([0, 1]);
  });

  it('keeps the streak separate per task', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask({ name: 'task-a' }));
    await seedTask(storage, makeTask({ name: 'task-b' }));
    const { runner } = makeRunner(async () => ({ status: 'failed', error: 'boom' }));
    const seen: string[] = [];
    const engine = createEngine({
      storage,
      runner,
      now: () => NOON,
      onRunFinal: (run, context) => { seen.push(`${run.taskName}:${context.previousFailures}`); },
    });

    await engine.triggerTask('task-a');
    await engine.triggerTask('task-b');
    await engine.triggerTask('task-a');

    expect(seen).toEqual(['task-a:0', 'task-b:0', 'task-a:1']);
  });
});

describe('engine — streak bookkeeping follows the terminal write', () => {
  it('does not advance the streak when the finish write fails (no double-count)', async () => {
    const storage = new MemoryStorage();
    await seedTask(storage, makeTask());
    let failWrites = true;
    const flaky = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop === 'finishRun' && failWrites) {
          return async () => {
            throw new Error('storage down');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Storage;
    const { runner } = makeRunner(async () => ({ status: 'failed', error: 'boom' }));
    const contexts: number[] = [];
    const engine = createEngine({
      storage: flaky,
      runner,
      now: () => NOON,
      onRunFinal: (_run, context) => { contexts.push(context.previousFailures); },
    });

    await expect(engine.triggerTask('task-a')).rejects.toThrow('storage down');
    expect(contexts).toEqual([]); // no terminal record, no hook

    failWrites = false;
    await engine.triggerTask('task-a');
    // The failed write left the counter where it was: this is still failure #1.
    expect(contexts).toEqual([0]);
  });
});
