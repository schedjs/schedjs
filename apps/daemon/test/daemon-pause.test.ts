import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createSqliteStorage, type RunOutcome, type Runner, type RunnerRunHooks } from '@schedjs/core';
import { createDaemon } from '../src/daemon.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/tasks.json', import.meta.url));
const NOW = new Date('2026-08-16T12:00:00Z');
/** A time that is due for the fixture's `every-minute` schedule (see daemon.test.ts). */
const DUE = new Date('2026-08-16T12:02:00Z');

function makeRunner() {
  const calls: string[] = [];
  const runner: Runner = {
    async run(task: { name: string }, _runId: string, _at: Date, _hooks?: RunnerRunHooks): Promise<RunOutcome> {
      calls.push(task.name);
      return { status: 'succeeded' };
    },
  };
  return { runner, calls };
}

describe('daemon — startPaused (R2)', () => {
  it('startPaused: true starts the queue frozen at process-start time', async () => {
    const storage = createSqliteStorage(new DatabaseSync(':memory:'));
    const { runner, calls } = makeRunner();
    const daemon = createDaemon({
      tasksPath: FIXTURE,
      storage,
      runners: { test: runner },
      now: () => NOW,
      startPaused: true,
    });

    await daemon.start();

    expect(daemon.engine.isPaused()).toBe(true);
    expect(daemon.engine.getPauseInfo()).toEqual({ paused: true, pausedAt: NOW, startPaused: true });

    await daemon.engine.runOnce(DUE); // due work exists, but the queue is frozen
    expect(calls).toHaveLength(0);

    daemon.stop();
  });

  it('does not persist the pause: a restart without startPaused is active', async () => {
    const storage = createSqliteStorage(new DatabaseSync(':memory:'));
    const first = createDaemon({
      tasksPath: FIXTURE,
      storage,
      runners: { test: makeRunner().runner },
      now: () => NOW,
      startPaused: true,
    });
    await first.start();
    expect(first.engine.isPaused()).toBe(true);
    first.stop();

    const { runner, calls } = makeRunner();
    const second = createDaemon({ tasksPath: FIXTURE, storage, runners: { test: runner }, now: () => NOW });
    await second.start();

    expect(second.engine.isPaused()).toBe(false);
    expect(second.engine.getPauseInfo()).toEqual({ paused: false, pausedAt: null, startPaused: false });

    await second.engine.runOnce(DUE);
    expect(calls.length).toBeGreaterThan(0); // active again

    second.stop();
  });

  it('starts frozen from SCHED_START_PAUSED=1 and active again without it', async () => {
    const storage = createSqliteStorage(new DatabaseSync(':memory:'));
    process.env.SCHED_START_PAUSED = '1';
    try {
      const frozen = createDaemon({
        tasksPath: FIXTURE,
        storage,
        runners: { test: makeRunner().runner },
        now: () => NOW,
      });
      await frozen.start();
      expect(frozen.engine.isPaused()).toBe(true);
      expect(frozen.engine.getPauseInfo()).toEqual({ paused: true, pausedAt: NOW, startPaused: true });
      frozen.stop();
    } finally {
      delete process.env.SCHED_START_PAUSED;
    }

    // restart without the ENV → active (the freeze is runtime-only)
    const { runner, calls } = makeRunner();
    const active = createDaemon({ tasksPath: FIXTURE, storage, runners: { test: runner }, now: () => NOW });
    await active.start();
    expect(active.engine.isPaused()).toBe(false);
    await active.engine.runOnce(DUE);
    expect(calls.length).toBeGreaterThan(0);
    active.stop();
  });

  it('SCHED_START_PAUSED is strict: only "1" freezes', async () => {
    const storage = createSqliteStorage(new DatabaseSync(':memory:'));
    try {
      for (const value of ['0', 'true']) {
        process.env.SCHED_START_PAUSED = value;
        const daemon = createDaemon({
          tasksPath: FIXTURE,
          storage,
          runners: { test: makeRunner().runner },
          now: () => NOW,
        });
        await daemon.start();
        expect(daemon.engine.isPaused()).toBe(false);
        daemon.stop();
      }
    } finally {
      delete process.env.SCHED_START_PAUSED;
    }
  });
});
