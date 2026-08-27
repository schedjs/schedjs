import { describe, expect, it } from 'vitest';
import { createInternalRunner } from '../../src/runners/internal.js';
import type { RunOutcome } from '../../src/engine.js';
import { makeTask } from '../../src/storage-contract.js';

const START = new Date('2026-08-16T12:00:00Z');

function taskWith(overrides: Record<string, unknown> = {}): ReturnType<typeof makeTask> {
  return makeTask({ runner: 'internal', config: { handler: 'job', data: { n: 42 }, ...overrides } });
}

describe('internal runner', () => {
  it('runs a handler with task config.data and reports its return value as the result', async () => {
    const runner = createInternalRunner({
      handlers: {
        job: async (data) => ({ got: (data as { n: number }).n * 2 }),
      },
    });

    const outcome = await runner.run(taskWith(), 'run-1', START);

    expect(outcome.status).toBe('succeeded');
    if (outcome.status === 'succeeded') {
      expect(outcome.result).toEqual({ got: 84 });
    }
  });

  it('passes runId / taskName / startedAt through the context', async () => {
    let seen: unknown = null;
    const runner = createInternalRunner({
      handlers: {
        job: async (_data, ctx) => {
          seen = ctx;
          return null;
        },
      },
    });

    await runner.run(taskWith(), 'run-abc', START);

    expect(seen).toMatchObject({ runId: 'run-abc', taskName: 'task-a', startedAt: START });
  });

  it('treats a throwing handler as a failed run with the error message', async () => {
    const runner = createInternalRunner({
      handlers: {
        job: async () => {
          throw new Error('boom: disk full');
        },
      },
    });

    const outcome = await runner.run(taskWith(), 'run-1', START);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toBe('boom: disk full');
    }
  });

  it('collects ctx.log lines and ctx.setProgress into the outcome', async () => {
    const runner = createInternalRunner({
      handlers: {
        job: async (_data, ctx) => {
          ctx.log('started');
          ctx.setProgress(50);
          ctx.log('halfway');
          ctx.setProgress(100);
          return { ok: true };
        },
      },
    });

    const outcome = (await runner.run(taskWith(), 'run-1', START)) as Extract<RunOutcome, { status: 'succeeded' }>;

    expect(outcome.status).toBe('succeeded');
    expect(outcome.log).toBe('started\nhalfway');
    expect(outcome.progress).toBe(100);
  });

  it('carries collected log lines into a failure outcome', async () => {
    const runner = createInternalRunner({
      handlers: {
        job: async (_data, ctx) => {
          ctx.log('doing work');
          throw new Error('failed mid-way');
        },
      },
    });

    const outcome = (await runner.run(taskWith(), 'run-1', START)) as Extract<RunOutcome, { status: 'failed' }>;

    expect(outcome.status).toBe('failed');
    expect(outcome.log).toBe('doing work');
  });

  it('fails fast on a task whose config.handler is missing', async () => {
    const runner = createInternalRunner({ handlers: { job: async () => null } });

    const outcome = await runner.run(taskWith({ handler: undefined }), 'run-1', START);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toMatch(/config\.handler/);
    }
  });

  it('fails fast on an unregistered handler, listing what is available', async () => {
    const runner = createInternalRunner({ handlers: { job: async () => null, other: async () => null } });

    const outcome = await runner.run(taskWith({ handler: 'nope' }), 'run-1', START);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toMatch(/handler "nope" not registered/);
      expect(outcome.error).toMatch(/job/);
      expect(outcome.error).toMatch(/other/);
    }
  });
});
