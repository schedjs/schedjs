import { describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from '../src/engine.js';
import { createEventLogger } from '../src/event-logger.js';

const RUN = '0123456789abcdef';

describe('createEventLogger', () => {
  it('formats engine events into single-line [sched] entries', () => {
    const lines: string[] = [];
    const logger = createEventLogger({ write: (l) => lines.push(l) });

    logger({ type: 'tick', at: new Date('2026-08-16T12:00:00Z'), dueCount: 3 });
    logger({ type: 'claim', taskName: 'task-a', runId: RUN, attempt: 1 });
    logger({ type: 'dispatch', taskName: 'task-a', runId: RUN, runner: 'http', attempt: 1 });
    logger({ type: 'run-succeeded', taskName: 'task-a', runId: RUN, attempt: 1 });
    logger({ type: 'run-failed', taskName: 'task-a', runId: RUN, attempt: 2, error: 'boom' });
    logger({ type: 'run-cancelled', taskName: 'task-a', runId: RUN, attempt: 1, error: 'timeout' });
    logger({
      type: 'retry-scheduled',
      taskName: 'task-a',
      runId: RUN,
      attempt: 1,
      nextRunAt: new Date('2026-08-16T12:01:00Z'),
      backoffMs: 60_000,
    });
    logger({ type: 'poll', taskName: 'task-a', runId: RUN, status: 'running', progress: 50 });
    logger({ type: 'poll', taskName: 'task-a', runId: RUN, status: 'succeeded', progress: 100 });
    logger({ type: 'zombie-reaped', olderThan: new Date('2026-08-16T11:30:00Z'), count: 2 });
    logger({ type: 'cancel-sent', taskName: 'task-a', runId: RUN, cancelUrl: 'http://worker:3000/cancel/1' });
    logger({ type: 'cancel-ack', taskName: 'task-a', runId: RUN, status: 200 });
    logger({ type: 'cancel-failed', taskName: 'task-a', runId: RUN, error: 'ECONNREFUSED' });
    logger({ type: 'cancel-no-channel', taskName: 'task-a', runId: RUN });

    expect(lines).toEqual([
      '[sched] tick: 3 due',
      '[sched] claim task-a run=01234567 attempt=1',
      '[sched] dispatch task-a run=01234567 runner=http attempt=1',
      '[sched] done task-a run=01234567 attempt=1',
      '[sched] fail task-a run=01234567 attempt=2: boom',
      '[sched] cancel task-a run=01234567 attempt=1: timeout',
      '[sched] retry task-a run=01234567 attempt=1 backoff=60000ms (next 2026-08-16 12:01:00Z)',
      '[sched] poll task-a run=01234567 status=running progress=50',
      '[sched] poll task-a run=01234567 status=succeeded progress=100',
      '[sched] reaped 2 zombie lock(s) older than 2026-08-16 11:30:00Z',
      '[sched] [cancel] POST http://worker:3000/cancel/1 runId=01234567 task=task-a',
      '[sched] [cancel] ack runId=01234567 status=200',
      '[sched] [cancel] failed: ECONNREFUSED runId=01234567',
      '[sched] [cancel] no cancelUrl — legacy stop-polling runId=01234567',
    ]);
  });

  it('writes to console.log by default', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createEventLogger();
    logger({ type: 'claim', taskName: 'a', runId: RUN, attempt: 1 });
    expect(spy).toHaveBeenCalledWith('[sched] claim a run=01234567 attempt=1');
    spy.mockRestore();
  });

  it('supports a filter of event types', () => {
    const lines: string[] = [];
    const logger = createEventLogger({ write: (l) => lines.push(l), filter: ['run-failed', 'zombie-reaped'] });

    logger({ type: 'claim', taskName: 'a', runId: RUN, attempt: 1 });
    logger({ type: 'run-failed', taskName: 'a', runId: RUN, attempt: 1, error: 'x' });
    logger({ type: 'zombie-reaped', olderThan: new Date('2026-08-16T11:30:00Z'), count: 1 });
    logger({ type: 'poll', taskName: 'a', runId: RUN, status: 'running', progress: 10 });

    expect(lines).toEqual([
      '[sched] fail a run=01234567 attempt=1: x',
      '[sched] reaped 1 zombie lock(s) older than 2026-08-16 11:30:00Z',
    ]);
  });

  it('supports a custom prefix', () => {
    const lines: string[] = [];
    const logger = createEventLogger({ write: (l) => lines.push(l), prefix: '[sched:prod]' });
    logger({ type: 'claim', taskName: 'a', runId: RUN, attempt: 1 });
    expect(lines).toEqual(['[sched:prod] claim a run=01234567 attempt=1']);
  });
});
