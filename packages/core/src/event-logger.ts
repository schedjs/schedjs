import type { EngineEvent } from './engine.js';

export interface EventLoggerOptions {
  /** Line sink. Default: `console.log`. Point it at pino to get structured output. */
  write?: (line: string) => void;
  /** Restrict to these event types (default: all). */
  filter?: EngineEvent['type'][];
  /** Line prefix. Default: `[sched]`. */
  prefix?: string;
}

/**
 * Thin adapter: turns the typed {@link EngineEvent} stream into human-readable
 * single-line logs. Wire it as the engine's `onEvent`:
 *
 * ```ts
 * const engine = createEngine({
 *   storage,
 *   runner,
 *   onEvent: createEventLogger(), // [sched] claim task-a run=ab12cd34 attempt=1
 * });
 * ```
 */
export function createEventLogger(opts: EventLoggerOptions = {}): (event: EngineEvent) => void {
  const write = opts.write ?? ((line: string) => console.log(line));
  const filter = opts.filter ? new Set(opts.filter) : null;
  const prefix = opts.prefix ?? '[sched]';
  return (event) => {
    if (filter && !filter.has(event.type)) return;
    write(format(event, prefix));
  };
}

function fmtTime(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

function format(event: EngineEvent, prefix: string): string {
  const id = (runId: string) => runId.slice(0, 8);
  switch (event.type) {
    case 'tick':
      return `${prefix} tick: ${event.dueCount} due`;
    case 'claim':
      return `${prefix} claim ${event.taskName} run=${id(event.runId)} attempt=${event.attempt}`;
    case 'dispatch':
      return `${prefix} dispatch ${event.taskName} run=${id(event.runId)} runner=${event.runner} attempt=${event.attempt}`;
    case 'run-succeeded':
      return `${prefix} done ${event.taskName} run=${id(event.runId)} attempt=${event.attempt}`;
    case 'run-failed':
      return `${prefix} fail ${event.taskName} run=${id(event.runId)} attempt=${event.attempt}: ${event.error}`;
    case 'run-cancelled':
      return `${prefix} cancel ${event.taskName} run=${id(event.runId)} attempt=${event.attempt}: ${event.error}`;
    case 'missed-slot':
      return `${prefix} missed-slot ${event.taskName} sched=${event.scheduleId} scheduled ${fmtTime(event.scheduledAt)} (${event.delayMs}ms late)`;
    case 'retry-scheduled':
      return `${prefix} retry ${event.taskName} run=${id(event.runId)} attempt=${event.attempt} backoff=${event.backoffMs}ms (next ${fmtTime(event.nextRunAt)})`;
    case 'poll':
      return `${prefix} poll ${event.taskName} run=${id(event.runId)} status=${event.status}${event.progress !== null ? ` progress=${event.progress}` : ''}`;
    case 'cancel-sent':
      return `${prefix} [cancel] POST ${event.cancelUrl} runId=${id(event.runId)} task=${event.taskName}`;
    case 'cancel-ack':
      return `${prefix} [cancel] ack runId=${id(event.runId)}${event.status !== undefined ? ` status=${event.status}` : ''}`;
    case 'cancel-failed':
      return `${prefix} [cancel] failed: ${event.error} runId=${id(event.runId)}`;
    case 'cancel-no-channel':
      return `${prefix} [cancel] no cancelUrl — legacy stop-polling runId=${id(event.runId)}`;
    case 'zombie-reaped':
      return `${prefix} reaped ${event.count} zombie lock(s) older than ${fmtTime(event.olderThan)}`;
    case 'recovered-orphans':
      return `${prefix} recovered ${event.count} orphaned run(s), released ${event.clearedLocks} lock(s)`;
    case 'retention-pruned':
      return `${prefix} pruned ${event.removed} run(s) (temporary < ${fmtTime(event.olderThanTemporary)}, regular < ${fmtTime(event.olderThanRegular)})`;
    case 'error':
      return `${prefix} error: ${event.message}`;
    case 'sync-failed':
      return `${prefix} sync failed (${event.consecutiveFailures}×): ${event.error}`;
  }
}
