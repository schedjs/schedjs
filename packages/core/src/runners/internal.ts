import type { RunOutcome, Runner, RunnerRunHooks } from '../engine.js';
import type { TaskRecord } from '../types.js';

/** What an in-process handler receives while it runs. */
export interface InternalRunContext {
  runId: string;
  taskName: string;
  startedAt: Date;
  /** Append one line to the run log (newline-joined). */
  log(line: string): void;
  /** Report 0-100 progress (lands in the final RunOutcome). */
  setProgress(percent: number): void;
}

/**
 * In-process handler. `data` is `task.config.data` — the run parameters.
 * Return value → run `result`; `undefined`/`null` → `result: null`.
 * A throw → `failed` with the error message (and any log lines collected so far).
 */
export type InternalHandler = (data: unknown, ctx: InternalRunContext) => unknown | Promise<unknown>;

/** Handler map: `task.config.handler` selects the entry. */
export type InternalHandlers = Record<string, InternalHandler>;

/**
 * Internal runner (embedded mode): executes handlers in the same process —
 * no HTTP, no docker, no daemon. `task.config.handler` names the function,
 * `task.config.data` is passed as its first argument.
 *
 * Sync-by-design: a handler runs to completion (or throws) — there is no
 * `accepted`/poll branch for in-process work. Long handlers are bounded by the
 * engine's concurrency, not a timeout — the embedding process owns that.
 */
export function createInternalRunner(options: { handlers: InternalHandlers }): Runner {
  const { handlers } = options;

  return {
    async run(task: TaskRecord, runId: string, startedAt: Date, hooks?: RunnerRunHooks): Promise<RunOutcome> {
      const cfg = task.config as { handler?: unknown; data?: unknown };
      const handlerName = cfg.handler;
      if (typeof handlerName !== 'string' || handlerName.length === 0) {
        return {
          status: 'failed',
          error: `internal runner: task "${task.name}" config.handler is required (name of a registered handler)`,
        };
      }
      const handler = handlers[handlerName];
      if (!handler) {
        const registered = Object.keys(handlers).join(', ') || 'none';
        return {
          status: 'failed',
          error: `internal runner: handler "${handlerName}" not registered (registered: ${registered})`,
        };
      }

      const logLines: string[] = [];
      let progress: number | null = null;
      const ctx: InternalRunContext = {
        runId,
        taskName: task.name,
        startedAt,
        log(line) {
          logLines.push(String(line));
        },
        setProgress(percent) {
          progress = percent;
        },
      };

      try {
        // Race the handler against the user-cancel signal: on abort the run is
        // cancelled immediately (the handler keeps executing in the background —
        // an in-process JS function cannot be force-interrupted; its eventual
        // result is discarded).
        const signal = hooks?.signal;
        const result = await new Promise<unknown>((resolve, reject) => {
          const onAbort = (): void => {
            const e = new Error('cancelled by user');
            e.name = 'AbortError';
            reject(e);
          };
          if (signal) {
            if (signal.aborted) return onAbort();
            signal.addEventListener('abort', onAbort, { once: true });
          }
          Promise.resolve()
            .then(() => handler(cfg.data, ctx))
            .then(resolve, reject);
        });
        const outcome: Extract<RunOutcome, { status: 'succeeded' }> = { status: 'succeeded', result: result ?? null };
        if (logLines.length > 0) outcome.log = logLines.join('\n');
        if (progress !== null) outcome.progress = progress;
        return outcome;
      } catch (err) {
        // user-cancel → AbortError, the engine maps it to cancelled
        if (err instanceof Error && err.name === 'AbortError') throw err;
        const outcome: Extract<RunOutcome, { status: 'failed' }> = {
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        };
        if (logLines.length > 0) outcome.log = logLines.join('\n');
        if (progress !== null) outcome.progress = progress;
        return outcome;
      }
    },
  };
}
