import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/engine.js';
import { createInternalRunner } from '../src/runners/internal.js';
import { createSqliteStorage } from '../src/sqlite.js';
import { syncTasks } from '../src/tasks-json.js';
import type { TaskRecord } from '../src/types.js';
import type { Storage } from '../src/storage.js';

const NOON = new Date('2026-08-16T12:00:00Z');

/** Slice-2 seed: task + its schedule row (id = task name). The engine drives schedules. */
async function seedTask(storage: Storage, t: TaskRecord): Promise<void> {
  await storage.upsertTask(t);
  await storage.createSchedule({
    id: t.name,
    taskName: t.name,
    schedule: t.schedule ?? { kind: 'interval', ms: 3_600_000 },
    tz: t.tz,
    data: null,
    externalId: null,
    dedupKey: null,
    nextRunAt: t.nextRunAt,
    lastRunAt: t.lastRunAt,
    lockedAt: t.lockedAt,
    failCount: t.failCount,
    priority: t.priority,
    retry: t.retry,
    retryCount: t.retryCount,
    lastRunId: t.lastRunId,
    paused: t.paused,
    disabled: t.disabled,
    fileManaged: true,
  });
}

function task(name: string, config: Record<string, unknown>, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    name,
    runner: 'internal',
    schedule: { kind: 'interval', ms: 3_600_000 },
    tz: 'UTC',
    config,
    label: null,
    description: null,
    nextRunAt: new Date('2026-08-16T11:59:00Z'), // due at NOON
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

/**
 * Embedded Shape 1 smoke: the "60 seconds" story — @schedjs/core in-process,
 * SQLite file, zero daemon. Pins the composition the quick-start documents:
 * createSqliteStorage + createInternalRunner + createEngine (+ syncTasks),
 * with maxConcurrent for parallel in-process handlers.
 */
describe('embedded mode (Shape 1) — zero daemon', () => {
  it('schedules in-process handlers, runs them, and records history in SQLite', async () => {
    const storage = createSqliteStorage(new DatabaseSync(':memory:'));
    const calls: string[] = [];
    const engine = createEngine({
      storage,
      runner: createInternalRunner({
        handlers: {
          sendDigest: async (data, ctx) => {
            calls.push((data as { to: string }).to);
            ctx.log('digest sent');
            return { recipients: 1 };
          },
        },
      }),
      maxConcurrent: 4,
      now: () => NOON,
    });

    await seedTask(storage, task('send-digest', { handler: 'sendDigest', data: { to: 'me@example.com' } }));

    await engine.runOnce();

    expect(calls).toEqual(['me@example.com']);
    const runs = await storage.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('succeeded');
    expect(runs[0]!.result).toEqual({ recipients: 1 });
    expect(runs[0]!.log).toBe('digest sent');
    expect(runs[0]!.attempt).toBe(1);
    // interval advanced by the engine from completion (runtime state on the schedule row)
    const t = await storage.getSchedule('send-digest');
    expect(t!.nextRunAt!.getTime()).toBe(Date.parse('2026-08-16T13:00:00Z'));
    expect(t!.lockedAt).toBeNull();
  });

  it('cancels a running in-process handler via hooks.signal (AbortError → cancelled)', async () => {
    const storage = createSqliteStorage(new DatabaseSync(':memory:'));
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const engine = createEngine({
      storage,
      runner: createInternalRunner({
        handlers: {
          slow: async () => {
            started();
            await gate;
            return { ok: true };
          },
        },
      }),
      now: () => NOON,
    });
    await seedTask(storage, task('slow-run', { handler: 'slow' }));

    const running = engine.runOnce();
    await startedP; // handler in flight
    const run = (await storage.listRuns())[0]!;
    expect(run.status).toBe('running');

    const cancelled = await engine.cancelRun(run.id);
    expect(cancelled!.status).toBe('cancelled');
    expect(cancelled!.error).toBe('cancelled by user');
    expect((await storage.getSchedule('slow-run'))!.lockedAt).toBeNull();
    release(); // let the background handler finish (its result is discarded)
    await running;
  });

  it('syncs a tasks.json-style desired state into storage with an internal runner', async () => {
    const storage = createSqliteStorage(new DatabaseSync(':memory:'));
    await syncTasks(
      storage,
      [
        {
          name: 'backup',
          runner: 'internal',
          schedules: [{ cron: '0 2 * * *' }],
          config: { handler: 'backup', data: { target: 's3://bucket' } },
          retry: { maxAttempts: 3, backoffMs: 60_000 },
          priority: 5,
        },
      ],
      NOON,
    );

    const t = await storage.getTask('backup');
    expect(t!.runner).toBe('internal');
    expect(t!.config).toEqual({ handler: 'backup', data: { target: 's3://bucket' } });
    expect(t!.retry).toEqual({ maxAttempts: 3, backoffMs: 60_000 });
    expect(t!.priority).toBe(5);
    expect(t!.nextRunAt!.getTime()).toBe(Date.parse('2026-08-17T02:00:00Z'));
  });

  it('retries a failing in-process handler with backoff, alerting only on exhaustion', async () => {
    const storage = createSqliteStorage(new DatabaseSync(':memory:'));
    const finals: Array<{ status: string; attempt: number }> = [];
    let attempts = 0;
    const engine = createEngine({
      storage,
      runner: createInternalRunner({
        handlers: {
          flaky: async () => {
            attempts += 1;
            throw new Error('upstream 503');
          },
        },
      }),
      now: () => NOON,
      onRunFinal: (r) => {
        finals.push({ status: r.status, attempt: r.attempt });
      },
    });

    await seedTask(storage, task('flaky', { handler: 'flaky', data: null }, { retry: { maxAttempts: 2, backoffMs: 5_000 } }));

    await engine.runOnce(); // attempt 1 → retry at NOON + 5s
    expect(attempts).toBe(1);
    expect(finals).toEqual([]); // alert deferred
    expect((await storage.getSchedule('flaky'))!.retryCount).toBe(1);
    expect((await storage.getSchedule('flaky'))!.failCount).toBe(0);

    await engine.runOnce(new Date('2026-08-16T12:00:05Z')); // attempt 2 → exhausted
    expect(attempts).toBe(2);
    expect(finals).toEqual([{ status: 'failed', attempt: 2 }]); // only the final failure alerted
    expect((await storage.getSchedule('flaky'))!.failCount).toBe(1);
    const runs = await storage.listRuns();
    expect(runs.map((r) => r.attempt).sort()).toEqual([1, 2]);
  });
});
