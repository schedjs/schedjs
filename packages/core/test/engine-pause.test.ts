import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/engine.js';
import type { EngineEvent, PollResult, RunOutcome, Runner, RunnerRunHooks } from '../src/engine.js';
import { makeTask } from '../src/storage-contract.js';
import type { Storage } from '../src/storage.js';
import type { ScheduleRecord, TaskRecord } from '../src/types.js';
import { MemoryStorage } from './helpers/memory-storage.js';

const NOW = new Date('2026-08-16T12:00:00Z');

function makeRunner(
  impl?: (
    task: TaskRecord,
    runId: string,
    startedAt: Date,
    hooks?: RunnerRunHooks,
  ) => Promise<RunOutcome>,
  pollImpl?: (runId: string, statusUrl: string, task?: TaskRecord) => Promise<PollResult>,
): {
  runner: Runner;
  calls: Array<{ task: TaskRecord; runId: string }>;
  pollCalls: string[];
} {
  const calls: Array<{ task: TaskRecord; runId: string }> = [];
  const pollCalls: string[] = [];
  const runner: Runner = {
    async run(task, runId, _startedAt, hooks) {
      calls.push({ task, runId });
      return impl ? impl(task, runId, _startedAt, hooks) : { status: 'succeeded' };
    },
    async poll(runId, statusUrl, task) {
      pollCalls.push(runId);
      return pollImpl ? pollImpl(runId, statusUrl, task) : { status: 'succeeded' };
    },
  };
  return { runner, calls, pollCalls };
}

/** Slice-2 seed: upsert the task AND its schedule row (mirrors engine.test.ts). */
async function seed(storage: Storage, task: TaskRecord, patch: Partial<ScheduleRecord> = {}): Promise<void> {
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
      ...patch,
    });
  }
}

describe('engine — queue pause (R2)', () => {
  it('blocks new claims while paused and reports the pause state', async () => {
    const storage = new MemoryStorage();
    await seed(storage, makeTask({ nextRunAt: NOW }));
    const { runner, calls } = makeRunner();
    const events: EngineEvent[] = [];
    const engine = createEngine({ storage, runner, now: () => NOW, onEvent: (e) => events.push(e) });

    engine.pause(NOW);

    expect(engine.isPaused()).toBe(true);
    expect(engine.getPauseInfo()).toEqual({ paused: true, pausedAt: NOW, startPaused: false });

    await engine.runOnce(NOW);

    expect(calls).toHaveLength(0);
    expect(events.filter((e) => e.type === 'claim' || e.type === 'tick')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'queue-paused')).toEqual([
      { type: 'queue-paused', pausedAt: NOW, startPaused: false },
    ]);
  });

  it('pause is idempotent: re-pausing keeps pausedAt and fires no second event', async () => {
    const storage = new MemoryStorage();
    const events: EngineEvent[] = [];
    const engine = createEngine({
      storage,
      runner: makeRunner().runner,
      now: () => NOW,
      onEvent: (e) => events.push(e),
    });

    engine.pause(new Date('2026-08-16T10:00:00Z'));
    engine.pause(NOW);

    expect(engine.getPauseInfo()).toEqual({
      paused: true,
      pausedAt: new Date('2026-08-16T10:00:00Z'),
      startPaused: false,
    });
    expect(events.filter((e) => e.type === 'queue-paused')).toHaveLength(1);
  });

  it('startPaused marks a process-start freeze; resume clears the flag', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine({ storage, runner: makeRunner().runner, now: () => NOW });

    engine.pause(NOW, { startPaused: true });
    expect(engine.getPauseInfo()).toEqual({ paused: true, pausedAt: NOW, startPaused: true });

    await engine.resume(NOW);
    expect(engine.getPauseInfo()).toEqual({ paused: false, pausedAt: null, startPaused: false });
  });

  it('resume skips overdue cron slots — nextRunAt lands in the future, no catch-up, no missed-slot', async () => {
    const storage = new MemoryStorage();
    await seed(
      storage,
      makeTask({
        schedule: { kind: 'cron', cron: '0 9 * * *' },
        nextRunAt: new Date('2026-08-16T09:00:00Z'),
        lastRunAt: new Date('2026-08-15T09:00:00Z'),
      }),
    );
    const { runner, calls } = makeRunner();
    const events: EngineEvent[] = [];
    const engine = createEngine({ storage, runner, now: () => NOW, onEvent: (e) => events.push(e) });

    engine.pause(new Date('2026-08-16T08:00:00Z'));
    const info = await engine.resume(NOW);

    expect(info).toEqual({ pausedMs: 4 * 3600 * 1000, skippedSchedules: 1, deferredRuns: 0 });
    expect((await storage.getSchedule('task-a'))!.nextRunAt).toEqual(new Date('2026-08-17T09:00:00Z'));

    await engine.runOnce(NOW); // the skipped slot must NOT fire now
    expect(calls).toHaveLength(0);
    expect(events.filter((e) => e.type === 'missed-slot')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'queue-resumed')).toEqual([
      {
        type: 'queue-resumed',
        pausedMs: 4 * 3600 * 1000,
        skippedSchedules: 1,
        deferredRuns: 0,
      },
    ]);
  });

  it('resume skips an overdue interval slot to exactly one future slot', async () => {
    const storage = new MemoryStorage();
    await seed(
      storage,
      makeTask({
        schedule: { kind: 'interval', ms: 5 * 60_000 },
        nextRunAt: new Date('2026-08-16T11:00:00Z'),
        lastRunAt: new Date('2026-08-16T10:55:00Z'),
      }),
    );
    const { runner, calls } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOW });

    engine.pause(new Date('2026-08-16T10:50:00Z'));
    const info = await engine.resume(NOW);

    expect(info.skippedSchedules).toBe(1);
    expect(info.deferredRuns).toBe(0);
    // exactly one next slot, in the future — the 11:00 slot was skipped, not queued
    expect((await storage.getSchedule('task-a'))!.nextRunAt).toEqual(new Date('2026-08-16T12:05:00Z'));

    await engine.runOnce(NOW);
    expect(calls).toHaveLength(0);
  });

  it('defers an overdue one-shot and plays it exactly once after resume', async () => {
    const at = new Date('2026-08-16T11:00:00Z');
    const storage = new MemoryStorage();
    await seed(storage, makeTask({ schedule: { kind: 'once', at }, nextRunAt: at }));
    const { runner, calls } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOW });

    engine.pause(new Date('2026-08-16T10:30:00Z'));
    const info = await engine.resume(NOW);

    expect(info).toEqual({ pausedMs: 90 * 60_000, skippedSchedules: 0, deferredRuns: 1 });
    // untouched — the intent survives the pause
    expect((await storage.getSchedule('task-a'))!.nextRunAt).toEqual(at);

    await engine.runOnce(NOW);
    expect(calls).toHaveLength(1);
    await engine.runOnce(NOW); // played exactly once
    expect(calls).toHaveLength(1);
    expect((await storage.getSchedule('task-a'))!.nextRunAt).toBeNull();
  });

  it('defers a pending retry (retryCount > 0) until resume, then plays it once', async () => {
    const storage = new MemoryStorage();
    await seed(
      storage,
      makeTask({
        schedule: { kind: 'interval', ms: 5 * 60_000 },
        nextRunAt: new Date('2026-08-16T11:00:00Z'),
        lastRunAt: new Date('2026-08-16T10:00:00Z'),
        retryCount: 1,
      }),
    );
    const { runner, calls } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOW });

    engine.pause(new Date('2026-08-16T10:30:00Z'));
    const info = await engine.resume(NOW);

    expect(info).toEqual({ pausedMs: 90 * 60_000, skippedSchedules: 0, deferredRuns: 1 });

    await engine.runOnce(NOW);
    expect(calls).toHaveLength(1);
    await engine.runOnce(NOW);
    expect(calls).toHaveLength(1);
  });

  it('does not fire missed-slot for a deferred slot that passed during the pause window', async () => {
    const storage = new MemoryStorage();
    await seed(
      storage,
      makeTask({
        schedule: { kind: 'interval', ms: 5 * 60_000 },
        nextRunAt: new Date('2026-08-16T11:00:00Z'),
        lastRunAt: new Date('2026-08-16T10:00:00Z'),
        retryCount: 1, // pending retry → deferred past resume, delay > grace
      }),
    );
    const { runner, calls } = makeRunner();
    const events: EngineEvent[] = [];
    const engine = createEngine({ storage, runner, now: () => NOW, onEvent: (e) => events.push(e) });

    engine.pause(new Date('2026-08-16T10:30:00Z'));
    await engine.resume(NOW);
    await engine.runOnce(NOW);

    expect(calls).toHaveLength(1);
    expect(events.filter((e) => e.type === 'missed-slot')).toHaveLength(0);
  });

  it('carries real counters: zeros when nothing is overdue at resume', async () => {
    const storage = new MemoryStorage();
    await seed(storage, makeTask({ nextRunAt: new Date('2026-08-16T13:00:00Z') }));
    const events: EngineEvent[] = [];
    const engine = createEngine({
      storage,
      runner: makeRunner().runner,
      now: () => NOW,
      onEvent: (e) => events.push(e),
    });

    engine.pause(NOW);
    const info = await engine.resume(new Date(NOW.getTime() + 60_000));

    expect(info).toEqual({ pausedMs: 60_000, skippedSchedules: 0, deferredRuns: 0 });
    expect(events.filter((e) => e.type === 'queue-resumed')).toEqual([
      { type: 'queue-resumed', pausedMs: 60_000, skippedSchedules: 0, deferredRuns: 0 },
    ]);
  });

  it('resume on an active queue is a no-op (zeros, no event)', async () => {
    const storage = new MemoryStorage();
    const events: EngineEvent[] = [];
    const engine = createEngine({
      storage,
      runner: makeRunner().runner,
      now: () => NOW,
      onEvent: (e) => events.push(e),
    });

    expect(await engine.resume(NOW)).toEqual({ pausedMs: 0, skippedSchedules: 0, deferredRuns: 0 });
    expect(events.filter((e) => e.type === 'queue-resumed')).toHaveLength(0);
  });

  it('keeps polling in-flight accepted runs while paused (queue brake, not a stop)', async () => {
    const storage = new MemoryStorage();
    await seed(storage, makeTask({ nextRunAt: NOW }));
    const { runner, pollCalls } = makeRunner(
      async () => ({ status: 'accepted', statusUrl: 'http://worker/1', pollIntervalMs: 0 }),
      async () => ({ status: 'succeeded', result: 'ok' }),
    );
    const engine = createEngine({ storage, runner, pollIntervalMs: 0, now: () => NOW });

    await engine.runOnce(NOW); // claims + enqueues the async run
    engine.pause(NOW);
    await engine.runPollOnce(NOW);

    expect(pollCalls).toHaveLength(1);
    expect((await storage.listRuns())[0]!.status).toBe('succeeded');
  });

  it('keeps retention/prune running while paused', async () => {
    const storage = new MemoryStorage();
    const pruned: Array<{ temporary: boolean }> = [];
    const original = storage.pruneRuns.bind(storage);
    storage.pruneRuns = async (f) => {
      pruned.push({ temporary: f.temporary });
      return original(f);
    };
    const engine = createEngine({ storage, runner: makeRunner().runner, now: () => NOW });

    engine.pause(NOW);
    await engine.runRetentionOnce(NOW);

    expect(pruned).toEqual([{ temporary: true }, { temporary: false }]);
  });

  it('ignores a tick snapshot that spanned a pause+resume (no stale catch-up run)', async () => {
    const storage = new MemoryStorage();
    await seed(storage, makeTask({ nextRunAt: NOW }));
    const { runner, calls } = makeRunner();
    const engine = createEngine({ storage, runner, now: () => NOW });

    // Hold the tick inside listDueSchedules so pause+resume land while its
    // due-snapshot is already computed.
    const dueSnapshot = storage.listDueSchedules.bind(storage);
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((r) => (markStarted = r));
    const gate = new Promise<void>((r) => (release = r));
    storage.listDueSchedules = async (now) => {
      const due = await dueSnapshot(now);
      markStarted();
      await gate;
      return due;
    };

    const tickPromise = engine.runOnce(NOW);
    await started;
    engine.pause(NOW);
    await engine.resume(NOW); // skips the slot the stale snapshot still holds
    release();
    await tickPromise;

    expect(calls).toHaveLength(0);
  });
});
