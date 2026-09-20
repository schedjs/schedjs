import { randomUUID } from 'node:crypto';
import { nextRun } from './cron.js';
import { InputValidationError, validateInput } from './input-schema.js';
import { resolveSchedulePolicy } from './policy.js';
import type { Storage } from './storage.js';
import type { ArtifactRef, RetryPolicy, RunRecord, ScheduleRecord, TaskRecord } from './types.js';

export type RunOutcome =
  | {
      status: 'succeeded';
      result?: unknown | null;
      progress?: number | null;
      log?: string | null;
      artifacts?: ArtifactRef[] | null;
    }
  | {
      status: 'failed';
      error: string;
      result?: unknown | null;
      progress?: number | null;
      log?: string | null;
      artifacts?: ArtifactRef[] | null;
    }
  | {
      status: 'cancelled';
      error: string;
      result?: unknown | null;
      progress?: number | null;
      log?: string | null;
      artifacts?: ArtifactRef[] | null;
    }
  | { status: 'accepted'; statusUrl: string; pollIntervalMs: number; cancelUrl?: string };

/** One response from the worker poll endpoint (pull model). */
export type PollResult =  | {
      status: 'queued' | 'running';
      progress?: number | null;
      log?: string | null;
      result?: unknown | null;
    }
  | {
      status: 'succeeded';
      result?: unknown | null;
      progress?: number | null;
      log?: string | null;
      artifacts?: ArtifactRef[] | null;
    }
  | {
      status: 'failed';
      error: string;
      result?: unknown | null;
      progress?: number | null;
      log?: string | null;
      artifacts?: ArtifactRef[] | null;
    };

/** Terminal poll variants only — what `finishAsyncRun` accepts. */
export type TerminalPollResult = Extract<PollResult, { status: 'succeeded' }> | Extract<PollResult, { status: 'failed' }>;

/** RunOutcome minus the accepted variant — what `recordFinish` persists. */
type SyncOutcome = Exclude<RunOutcome, { status: 'accepted' }>;

/**
 * One engine-lifecycle event (level 3 of sched's observability — see
 * docs/12.logging.md). Fired via {@link EngineConfig.onEvent}; consumers get a
 * typed union, so retries and zombie reaps carry distinct payloads instead of
 * being flattened into a single log call.
 *
 * `tick` fires only when something is actually due (a 1s-cadence "0 due" line
 * would be noise). `zombie-reaped` likewise only when locks were reaped.
 * Retry semantics: a failed attempt emits `run-failed` (per-attempt) and — when
 * a retry is still planned — `retry-scheduled` with the backoff; the final,
 * exhausted failure emits only `run-failed` (the persistent-fail alert lands
 * via {@link EngineConfig.onRunFinal}).
 */
export type EngineEvent =
  | { type: 'tick'; at: Date; dueCount: number }
  | { type: 'claim'; taskName: string; runId: string; attempt: number }
  | { type: 'dispatch'; taskName: string; runId: string; runner: string; attempt: number }
  | { type: 'run-succeeded'; taskName: string; runId: string; attempt: number }
  | { type: 'run-failed'; taskName: string; runId: string; attempt: number; error: string }
  | { type: 'run-cancelled'; taskName: string; runId: string; attempt: number; error: string }
  | {
      type: 'missed-slot';
      taskName: string;
      scheduleId: string;
      runner: string;
      /** The slot that was missed (schedule.nextRunAt at dispatch time). */
      scheduledAt: Date;
      /** How late the catch-up dispatch is (dispatch time − scheduledAt). */
      delayMs: number;
    }
  | { type: 'retry-scheduled'; taskName: string; runId: string; attempt: number; nextRunAt: Date; backoffMs: number }
  | { type: 'poll'; taskName: string; runId: string; status: PollResult['status']; progress: number | null }
  | { type: 'zombie-reaped'; olderThan: Date; count: number }
  | { type: 'recovered-orphans'; count: number; clearedLocks: number }
  | { type: 'retention-pruned'; olderThanTemporary: Date; olderThanRegular: Date; removed: number }
  | { type: 'error'; message: string }
  /**
   * The daemon's tasks.json sync failed (storage unreachable, broken file).
   * Emitted by the daemon's sync loop, not the engine — same alerts channel.
   * `consecutiveFailures` counts the current streak (1 = first failure).
   */
  | { type: 'sync-failed'; error: string; consecutiveFailures: number }
  // Async-cancel channel observability (battle-stand debugging 2026-08-21):
  // one line per cancel attempt so the operator can tell «signal never sent»
  // from «sent and failed» from «acked» (docs/08.logging.md → Engine events).
  | { type: 'cancel-sent'; taskName: string; runId: string; cancelUrl: string }
  | { type: 'cancel-ack'; taskName: string; runId: string; status?: number }
  | { type: 'cancel-failed'; taskName: string; runId: string; error: string }
  | { type: 'cancel-no-channel'; taskName: string; runId: string };

/**
 * Executes a claimed task. The engine owns scheduling and state; the runner owns
 * *how* a task runs — HTTP call, docker container, in-process function (tests).
 *
 * A sync outcome carries everything the worker reports back (result/log/progress/
 * artifacts) — the engine stores it verbatim on the RunRecord via `finishRun`.
 *
 * `poll` is optional: a runner that never returns `accepted` doesn't need it.
 * When `run` returns `accepted`, the engine marks the run `queued` and calls
 * `poll(runId, statusUrl)` on its own cadence until a terminal result arrives.
 */
export interface RunnerRunHooks {
  /**
   * Report live progress (0–100) while the run is in flight. Sync runners that
   * understand granular progress (e.g. process/docker stdio envelope) call it
   * on each intermediate `running` update; the engine persists it to storage
   * so the UI can show it growing before the run finishes.
   */
  onProgress?(progress: number): void | Promise<void>;
  /**
   * User-cancel signal (POST /runs/:id/cancel → engine.cancelRun). A runner
   * MUST react to `abort`: kill/abort its work and reject (or return a
   * `cancelled` outcome). The engine maps an `AbortError` rejection to
   * `cancelled`. Absent → the run cannot be cancelled mid-flight (still
   * cancellable while queued).
   */
  signal?: AbortSignal;
}

export interface Runner {
  run(
    task: TaskRecord,
    runId: string,
    startedAt: Date,
    hooks?: RunnerRunHooks,
  ): Promise<RunOutcome>;
  /**
   * Optional load-time validation. The host (daemon) calls it for every task at
   * start; throwing aborts startup with a clear error (fail-fast, before any
   * run). Lets a runner reject a bad task config early — e.g. a docker task
   * whose image is outside the allowlist.
   */
  validateConfig?(task: { name: string; config?: unknown }): void;
  /**
   * Polls an accepted run's statusUrl. `task` is the originating task — needed
   * by runners whose poll request must carry per-task config (e.g. auth).
   */
  poll?(runId: string, statusUrl: string, task?: TaskRecord): Promise<PollResult>;
  /**
   * Optional user-cancel channel for accepted (async) runs — called by
   * `cancelRun` while the run is still being polled. The runner tells its
   * worker to stop (the http runner POSTs `{runId}` to the worker's advertised
   * `cancelUrl`; a custom runner can kill its process/container). Absent →
   * cancel = stop polling only (legacy: the worker may keep running until it
   * finishes on its own — documented). A throw still cancels the run (the
   * signal is best-effort); the failure lands in the run's error so the
   * operator knows the worker may still be executing. Returns the transport
   * status when one applies (the http runner returns the response status).
   */
  cancel?(runId: string, statusUrl: string, task?: TaskRecord, cancelUrl?: string | null): Promise<number | void>;
}

/**
 * Streak context handed to {@link EngineConfig.onRunFinal} alongside the
 * finished run — what the alert contract (`onStreak` / `consecutiveFailures` /
 * «отпустило») is computed from.
 *
 * Source: the engine's in-memory consecutive-terminal-failure tracker, keyed by
 * task name, snapshotted BEFORE the terminal write (the run being finished is
 * not counted). "Terminal" = the run reached a persistent verdict: a failure
 * with a retry still scheduled is *not* counted (the whole ladder is one
 * incident — `run.attempt` carries its depth), and a `cancelled` run counts for
 * neither side (a human acted, not the pipeline).
 *
 * Why not `failCount`: the storage field is *cumulative* — every adapter does
 * `fail_count += failed ? 1 : 0` and a success never resets it (pinned by the
 * shared contract suite), so it cannot express «consecutive». A reset-on-success
 * column would be a Storage-contract change (5 adapters), out of scope for the
 * streak alert. Accepted cost (design wiki:3700): a daemon restart forgets an
 * in-flight streak — the next failure re-alerts once instead of staying silent.
 * No alert is ever *lost*, which is the direction that matters (a red task must
 * not go quiet).
 */
export interface RunFinalContext {
  /** Terminal (persistent) failures of the current streak BEFORE this run (0 = fresh incident). */
  previousFailures: number;
}

export interface EngineConfig {
  storage: Storage;
  runner: Runner;
  /** Injectable clock for deterministic tests. Default: `() => new Date()`. */
  now?: () => Date;
  /**
   * Fired after a run reaches a terminal state (succeeded / failed / cancelled),
   * with the finished RunRecord and its streak context. Platform-level
   * consumers: status alerts, metrics.
   * A failed run that still has retries scheduled does NOT fire the hook — the
   * alert lands only on the final, exhausted failure (persistent fail).
   */
  onRunFinal?: (run: RunRecord, context: RunFinalContext) => void | Promise<void>;
  /**
   * A schedule dispatched more than `missedSlotGraceMs` after its slot fires a
   * `missed-slot` event (downtime catch-up, wedged lock). Signal is
   * cause-agnostic — a long queue behind other runs reads the same as downtime;
   * tune the grace to your engine's expected queueing delay. Fresh schedules
   * (never run) never fire it — a fresh schedule's first slot is always in the
   * future, and the check additionally requires run history (`lastRunAt`), so a
   * history-less schedule dispatched late (e.g. a one-shot with `at` in the
   * past) is not reported as a miss either.
   * Default: 120_000 (2 min).
   */
  missedSlotGraceMs?: number;
  /**
   * Engine-lifecycle observer: claim / dispatch / run outcome / retry schedule /
   * poll / zombie reap — the native "engine events" level (docs/12.logging.md).
   * Default: no-op — the engine stays silent, exactly as before. Observer
   * errors are swallowed: a throwing logger must never break the scheduler.
   * See {@link createEventLogger} for the ready-made console/pino adapter.
   */
  onEvent?: (event: EngineEvent) => void;
  /**
   * How many due tasks may run concurrently. Default: 1 (sequential — the
   * daemon behaviour). Embedded mode raises it to parallelize in-process
   * handlers. Per-task overlap is still impossible: the storage claim is
   * atomic, so a task never runs twice while locked.
   */
  maxConcurrent?: number;
  /** Zombie-lock threshold. Default: 30 min. */
  lockTtlMs?: number;
  /**
   * Lock-heartbeat cadence: while a sync run is in flight, the engine refreshes
   * the task's lock every `lockHeartbeatMs` so a long run (longer than
   * `lockTtlMs`) is never reaped mid-flight by the zombie watchdog. Must be
   * < `lockTtlMs`. Default: `lockTtlMs / 3` (10 min at the 30 min default).
   */
  lockHeartbeatMs?: number;
  /**
   * Retention TTL for regular runs (terminal `succeeded|failed|cancelled`),
   * measured from `finishedAt`. Default: 30 days. See {@link Engine.runRetentionOnce}.
   */
  retentionMs?: number;
  /** Retention TTL for `temporary: true` runs. Default: 24 hours. */
  temporaryRetentionMs?: number;
  /** Tick cadence. Default: 1s. */
  tickIntervalMs?: number;
  /** Watchdog cadence. Default: 60s. */
  watchdogIntervalMs?: number;
  /** Poll cadence (how often queued async runs are re-polled). Default: 1s. */
  pollIntervalMs?: number;
  /** Retention sweep cadence. Default: 1h. */
  retentionIntervalMs?: number;
  /**
   * Hard ceiling for an async (accepted) run, measured from acceptance.
   * Must be < `lockTtlMs` — otherwise the zombie watchdog could unlock the task
   * and re-dispatch a live async run right when its poll times out. Default:
   * 25 min (5 min margin under the 30 min lock TTL, so the poll always fails the
   * run before the watchdog can reap its lock). Passed run → failed.
   */
  pollTimeoutMs?: number;
}

export interface Engine {
  /** Start tick + watchdog intervals. */
  start(): void;
  /** Stop both intervals. In-flight run is awaited by the caller, not interrupted. */
  stop(): void;
  /** One tick pass: fire everything due at `now` (defaults to the clock). */
  runOnce(now?: Date): Promise<void>;
  /** One watchdog pass: reap zombie locks older than `now - lockTtl`. */
  runWatchdogOnce(now?: Date): Promise<void>;
  /** One poll pass: poll every queued async run whose interval has elapsed. */
  runPollOnce(now?: Date): Promise<void>;
  /**
   * One retention pass: prune terminal runs past their TTL — temporary class
   * older than `temporaryRetentionMs` (24h), regular class older than
   * `retentionMs` (30d). Runs in-process so embedded engines stay clean too.
   */
  runRetentionOnce(now?: Date): Promise<void>;
  /**
   * Startup recovery: cancel orphaned in-flight runs (`running`/`queued` with
   * `finishedAt = null` — left behind by a previous process) and release every
   * task lock immediately, without waiting for lockTtl. At-least-once: the
   * affected tasks re-dispatch on the next tick (catch-up). Unlike
   * `runWatchdogOnce` it does NOT bump failCount — an interrupted run is an
   * infrastructure event, not a task failure. Returns the number of recovered
   * runs. The daemon calls this on start, before `engine.start()`.
   */
  recoverOrphanRuns(now?: Date): Promise<number>;
  /**
   * Ad-hoc run (agenda.now() equivalent): execute the task immediately through
   * the runner, recording run history, WITHOUT touching its schedule. Works for
   * paused/disabled tasks (explicit manual trigger). Returns null if unknown.
   * `opts.data` overrides the task's default data (`{ ...task.config.data,
   * ...opts.data }` — books one-off parity); `opts.temporary` selects the
   * retention class; `opts.triggeredBy` names the caller (identity-agnostic).
   */
  triggerTask(name: string, opts?: TriggerTaskOptions, now?: Date): Promise<RunRecord | null>;
  /**
   * Manual retry (admin `POST /runs/:id/retry`): execute the original run again
   * with `data = run.data` (not task defaults), `retryOf = run.id`, `trigger =
   * 'manual'`, `temporary` inherited from the original, `triggeredBy` fresh.
   * The original run is never touched (audit). Returns null if the run or its
   * task is unknown.
   */
  retryRun(runId: string, opts?: { triggeredBy?: string | null }, now?: Date): Promise<RunRecord | null>;
  /**
   * User cancel (admin `POST /runs/:id/cancel`). Returns the (now terminal)
   * RunRecord, or null for an unknown run. For a run still being polled
   * (queued / running-async) it is dropped from the poll queue and finished
   * `cancelled` (schedule advanced, lock released). For a sync run in flight it
   * aborts the runner via `hooks.signal` and AWAITS the actual stop (the run
   * comes back `cancelled`). A terminal run is returned unchanged — the caller
   * decides (409).
   */
  cancelRun(runId: string, now?: Date): Promise<RunRecord | null>;
}

export interface TriggerTaskOptions {
  /** Data override — merged over the task's default `config.data` (books one-off parity). */
  data?: unknown;
  /** Retention class of the resulting run. Default: false (regular, 30d TTL). */
  temporary?: boolean;
  /** Caller identity (email/name). sched stays identity-agnostic — caller-supplied. */
  triggeredBy?: string | null;
}

/**
 * triggerTask data-override (books one-off parity): merge `opts.data` over the
 * task's default data. No override → the default unchanged. A scalar override
 * replaces the default wholesale (a merge only makes sense object-over-object).
 */
function mergeRunData(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  const isObj = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(override)) return override;
  return { ...(isObj(base) ? base : {}), ...override };
}

/**
 * Dispatch view: the runner sees the run's data as the payload — config.data/body
 * overridden when the run carries data. Same mechanism as the schedule path, so
 * a manual trigger's data override (decision 12) and a retry's run.data (decision
 * 6) reach the worker instead of living only in the run record. Runners stay
 * dumb: they keep reading task.config.data/body.
 */
function dispatchView(task: TaskRecord, data: unknown): TaskRecord {
  return data !== null && data !== undefined
    ? { ...task, config: { ...task.config, data, body: data } }
    : task;
}

/**
 * Self-rolled scheduler core: a deterministic tick loop + zombie watchdog over
 * the {@link Storage} seam. Single-replica by design (HA = BullMQ / SKIP LOCKED,
 * see books scheduler-core-replace).
 *
 * Catch-up: tasks whose nextRunAt is in the past fire once on the next tick,
 * then reschedule from *completion time* — missed slots are not back-filled.
 */
export function createEngine(config: EngineConfig): Engine {
  const { storage, runner } = config;
  const clock = config.now ?? (() => new Date());
  const lockTtlMs = config.lockTtlMs ?? 30 * 60 * 1000;
  const lockHeartbeatMs = config.lockHeartbeatMs ?? Math.floor(lockTtlMs / 3);
  const retentionMs = config.retentionMs ?? 30 * 24 * 60 * 60 * 1000; // 30 days
  const temporaryRetentionMs = config.temporaryRetentionMs ?? 24 * 60 * 60 * 1000; // 24 hours
  const maxConcurrent = config.maxConcurrent ?? 1;
  const tickIntervalMs = config.tickIntervalMs ?? 1_000;
  const watchdogIntervalMs = config.watchdogIntervalMs ?? 60_000;
  const pollIntervalMs = config.pollIntervalMs ?? 1_000;
  const missedSlotGraceMs = config.missedSlotGraceMs ?? 2 * 60 * 1000;
  const retentionIntervalMs = config.retentionIntervalMs ?? 60 * 60 * 1000; // 1 hour
  // 25 min < lockTtl 30 min: the poll must fail a hung async run before the
  // zombie watchdog could unlock its task and re-dispatch a live run.
  const pollTimeoutMs = config.pollTimeoutMs ?? 25 * 60 * 1000;

  // r7 F2: enforce the documented invariant instead of silently accepting a
  // config where the zombie watchdog can reap a live long sync run. The async
  // poll ceiling keeps its margin by test (defaults 25 min < 30 min), not by a
  // runtime throw — a sync-only config with a tiny lockTtl stays legal.
  if (lockHeartbeatMs >= lockTtlMs) {
    throw new Error(`engine: lockHeartbeatMs (${lockHeartbeatMs}) must be < lockTtlMs (${lockTtlMs})`);
  }

  let tickTimer: NodeJS.Timeout | null = null;
  let watchdogTimer: NodeJS.Timeout | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let retentionTimer: NodeJS.Timeout | null = null;
  let ticking = false;

  /**
   * Consecutive terminal failures per task — the streak behind
   * {@link RunFinalContext.previousFailures}. In-memory by design: the storage
   * `failCount` is cumulative (see the interface docs) and a persisted
   * consecutive-counter would be a Storage-contract change. Only *terminal*
   * (alert-eligible) runs count: a retry-pending failure is not an incident yet,
   * and `cancelled` neither counts nor breaks a streak (a human acted, not the
   * pipeline). Keyed by task name — the same key alerts route on.
   */
  const failureStreaks = new Map<string, number>();

  /** Emit an engine-lifecycle event; observer errors never break the engine. */
  function fire(event: EngineEvent): void {
    if (!config.onEvent) return;
    try {
      config.onEvent(event);
    } catch {
      // an observer bug is an observability problem, not an engine bug
    }
  }

  /**
   * In-memory queue of accepted async runs (Model A pull). Not persisted across
   * restarts — a daemon crash mid-poll leaves the run `queued` in storage; the
   * runId-idempotent re-dispatch (http-runner v2) makes the next run safe.
   */
  interface AsyncRun {
    task: TaskRecord;
    /** The schedule that fired this run; null → ad-hoc trigger/retry (schedule untouched on completion). */
    schedule: ScheduleRecord | null;
    statusUrl: string;
    /** Worker cancel channel advertised in the accepted envelope; null → legacy stop-polling cancel. */
    cancelUrl: string | null;
    /** True once a cancel signal was sent — guards against a double POST /cancel (user cancel racing a timeout). */
    cancelSignaled: boolean;
    /** True once finishAsyncRun started — atomic first-finisher-wins across cancelRun and the poll/timeout paths. */
    finishing: boolean;
    pollIntervalMs: number;
    nextPollAt: number;
    acceptedAt: number;
  }
  const asyncRuns = new Map<string, AsyncRun>();

  /**
   * Sync runs currently in flight (runner invoked, not yet terminal), keyed by
   * runId — the cancel registry. `done` resolves when the run finishes; a
   * non-abortable runner that hangs keeps `done` pending (the run was going to
   * hang anyway — that is what cancel is for).
   */
  const runningRuns = new Map<string, { controller: AbortController; done: Promise<void> }>();

  /** Map a throwing runner to an outcome: user-cancel → cancelled, everything else → failed. */
  function outcomeFromThrow(err: unknown): Extract<RunOutcome, { status: 'cancelled' } | { status: 'failed' }> {
    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 'cancelled', error: err.message };
    }
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }

  /**
   * Arm the run-deadline abort for a sync run (task.timeoutMs > 0). The engine
   * aborts the runner via its signal at the deadline; the runner reports
   * cancelled/failed and `applyRunDeadline` rewrites the outcome to a clear
   * timeout failure. `-1`/absent → no deadline (manual cancel is the only stop).
   */
  function armRunDeadline(task: TaskRecord, controller: AbortController): { fired: () => boolean; dispose: () => void } {
    const timeoutMs = task.timeoutMs ?? null;
    if (timeoutMs === null || timeoutMs <= 0) return { fired: () => false, dispose: () => {} };
    let fired = false;
    const timer = setTimeout(() => {
      fired = true;
      controller.abort();
    }, timeoutMs);
    return { fired: () => fired, dispose: () => clearTimeout(timer) };
  }

  /** A sync run that aborted because its deadline fired reports a timeout failure (never 'cancelled by user'). */
  function applyRunDeadline(outcome: RunOutcome, deadline: { fired: () => boolean }, timeoutMs: number): RunOutcome {
    if (deadline.fired() && (outcome.status === 'cancelled' || outcome.status === 'failed')) {
      return { status: 'failed', error: `run timeout after ${timeoutMs}ms` };
    }
    return outcome;
  }

  function computeNext(schedule: ScheduleRecord, from: Date): Date | null {
    switch (schedule.schedule.kind) {
      case 'cron':
        return nextRun(schedule.schedule.cron, from, { tz: schedule.tz });
      case 'interval':
        return new Date(from.getTime() + schedule.schedule.ms);
      case 'once':
        return null; // one-shot fired — schedule exhausted
    }
  }

  /**
   * Retry plan for a failed run: `null` when no policy / retries exhausted.
   * Backoff grows as `backoffMs * multiplier^retriesConsumed`. `maxAttempts` is
   * the total attempts budget (1 = no retries), so a retry is scheduled while
   * `retryCount < maxAttempts - 1`. The policy is the schedule's EFFECTIVE one
   * (materialized at sync: schedule ?? task default — slice 3 refines).
   */
  function planRetry(policy: RetryPolicy | null, retryCount: number, now: Date): { nextRunAt: Date; count: number } | null {
    if (!policy) return null;
    if (retryCount >= policy.maxAttempts - 1) return null; // no attempts left
    const multiplier = policy.multiplier ?? 1;
    const backoff = policy.backoffMs * Math.pow(multiplier, retryCount);
    return { nextRunAt: new Date(now.getTime() + backoff), count: retryCount + 1 };
  }

  /**
   * Snapshot the run BEFORE finishRun and notify the final hook from it — the
   * alert must NOT depend on a second storage read after the terminal write
   * (a storage hiccup in that window loses the alert while the run IS failed —
   * books/mongo incident class 2026-08-24, task:1390). The pre-finish record
   * carries id/runner/startedAt/attempt; the outcome supplies the terminal
   * fields (status/error/result/progress/log/artifacts/finishedAt).
   */
  async function finalRunRecord(runId: string, outcome: SyncOutcome): Promise<RunRecord | null> {
    const base = await storage.getRun(runId);
    if (!base) return null;
    return {
      ...base,
      status: outcome.status,
      error: outcome.status === 'failed' || outcome.status === 'cancelled' ? outcome.error : null,
      result: outcome.result ?? null,
      progress: outcome.progress ?? null,
      log: outcome.log ?? null,
      artifacts: outcome.artifacts ?? null,
      // engine clock — the same source the schedule advance uses; the persisted
      // finishedAt lands a moment later (storage write), the alert is the
      // engine's view of «when it finished»
      finishedAt: clock(),
    };
  }

  /** Persist live progress reported by the runner (sync path) while the run is in flight. */
  async function reportProgress(runId: string, progress: number): Promise<void> {
    try {
      await storage.updateRun(runId, { progress });
    } catch {
      // a progress write must never fail a run — best-effort observability
    }
  }

  /**
   * Books `job.touch()` parity (see lock-heartbeat): refresh the claimed
   * SCHEDULE's lock every `lockHeartbeatMs` while a sync run is in flight, so a
   * long run (longer than `lockTtlMs`) is never reaped mid-flight by the zombie
   * watchdog. Returns a stop function. Errors are swallowed — a failed refresh
   * must never fail the run; the watchdog stays the ceiling for a genuinely
   * hung run whose heartbeat died (daemon down → no refresh → lock ages → reap
   * → re-dispatch, at-least-once intact).
   */
  function startHeartbeat(scheduleId: string): () => void {
    const timer = setInterval(() => {
      storage.refreshScheduleLock(scheduleId, clock()).catch(() => {
        // best-effort: heartbeat is liveness, not correctness
      });
    }, lockHeartbeatMs);
    return () => clearInterval(timer);
  }

  function recordFinish(taskName: string, runId: string, outcome: SyncOutcome, attempt: number, notify = true): Promise<void> {
    fire(outcomeEvent(taskName, runId, outcome, attempt));
    // Streak snapshot BEFORE the terminal write (the run in flight is not
    // counted yet). The counter itself is advanced only AFTER the write lands
    // (below) — a failed write must not move a streak for a run that never went
    // terminal — and only for terminal, alert-eligible runs: a retry-pending
    // failure (`notify: false`) leaves the incident open, and `cancelled` is
    // neither a failure nor a recovery.
    const previousFailures = failureStreaks.get(taskName) ?? 0;
    return (async () => {
      // Snapshot BEFORE finishRun — the final hook must not re-read storage
      // after the terminal write (a read failure there silently loses the
      // alert; task:1390). The snapshot carries the identity fields (attempt
      // from the persisted record — the run's actual value); outcome supplies
      // the terminal ones.
      const finalRecord = notify && config.onRunFinal ? await finalRunRecord(runId, outcome) : null;
      await storage.finishRun(runId, {
        status: outcome.status,
        error: outcome.status === 'failed' || outcome.status === 'cancelled' ? outcome.error : null,
        result: outcome.result ?? null,
        progress: outcome.progress ?? null,
        log: outcome.log ?? null,
        artifacts: outcome.artifacts ?? null,
      });
      if (notify) {
        if (outcome.status === 'failed') failureStreaks.set(taskName, previousFailures + 1);
        else if (outcome.status === 'succeeded') failureStreaks.delete(taskName);
      }
      if (finalRecord) await config.onRunFinal!(finalRecord, { previousFailures });
    })();
  }

  /** Per-attempt terminal event for a sync/async outcome (retry state excluded). */
  function outcomeEvent(taskName: string, runId: string, outcome: SyncOutcome, attempt: number): EngineEvent {
    switch (outcome.status) {
      case 'succeeded':
        return { type: 'run-succeeded', taskName, runId, attempt };
      case 'failed':
        return { type: 'run-failed', taskName, runId, attempt, error: outcome.error };
      case 'cancelled':
        return { type: 'run-cancelled', taskName, runId, attempt, error: outcome.error };
    }
  }

  /**
   * Finish a schedule-fired run and advance the SCHEDULE (runtime state lives
   * on schedule rows since slice 2). A failed run with retries left reschedules
   * at the backoff time (retryCount++, no failCount, no final hook); otherwise
   * the schedule advances normally and the failure is final.
   */
  async function completeScheduleRun(
    schedule: ScheduleRecord,
    task: TaskRecord,
    runId: string,
    outcome: SyncOutcome,
    finishedAt: Date,
    opts: { retry?: boolean } = {},
  ): Promise<void> {
    const isFailed = outcome.status === 'failed';
    const attempt = schedule.retryCount + 1;
    // Effective policy at retry-planning time (snapshot semantics: an edit in
    // the backoff window affects the NEXT dispatch, not this pending retry).
    const effective = resolveSchedulePolicy(task, schedule);
    const retryPlan =
      opts.retry !== false && isFailed ? planRetry(effective.retry, schedule.retryCount, finishedAt) : null;
    if (retryPlan) {
      await recordFinish(schedule.taskName, runId, outcome, attempt, false); // alert deferred — a retry is pending
      fire({
        type: 'retry-scheduled',
        taskName: schedule.taskName,
        runId,
        attempt,
        nextRunAt: retryPlan.nextRunAt,
        backoffMs: retryPlan.nextRunAt.getTime() - finishedAt.getTime(),
      });
      await storage.completeSchedule(schedule.id, {
        nextRunAt: retryPlan.nextRunAt,
        lastRunAt: finishedAt,
        failed: false, // not a persistent failure yet
        retryCount: retryPlan.count,
        lastRunId: runId,
      });
      return;
    }
    await recordFinish(schedule.taskName, runId, outcome, attempt, true);
    await storage.completeSchedule(schedule.id, {
      nextRunAt: computeNext(schedule, finishedAt),
      lastRunAt: finishedAt,
      failed: isFailed,
      retryCount: 0,
      lastRunId: runId,
    });
  }

  /**
   * Signal the worker to stop at the next stage boundary (async cancel channel
   * advertised in the accepted envelope). Shared by user cancel (cancelRun) and
   * auto-termination (poll/run timeout) — both must tell the worker BEFORE
   * finishing the run, otherwise the verdict diverges from reality (the worker
   * keeps publishing after a timeout is recorded). Returns a suffix to append to
   * the run's error when the signal itself failed ('' on success or no channel);
   * fires cancel-sent/cancel-ack/cancel-failed/cancel-no-channel events. Never
   * throws — a cancel-signal failure must not mask the timeout itself.
   */
  async function signalCancel(runId: string, ar: AsyncRun): Promise<string> {
    if (ar.cancelSignaled) return ''; // idempotent: cancelRun racing a timeout must not double-POST
    ar.cancelSignaled = true;
    if (ar.cancelUrl && runner.cancel) {
      fire({ type: 'cancel-sent', taskName: ar.task.name, runId, cancelUrl: ar.cancelUrl });
      try {
        const status = await runner.cancel(runId, ar.statusUrl, ar.task, ar.cancelUrl);
        fire({
          type: 'cancel-ack',
          taskName: ar.task.name,
          runId,
          ...(status !== undefined ? { status } : {}),
        });
        return '';
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        fire({ type: 'cancel-failed', taskName: ar.task.name, runId, error: reason });
        return ` (cancel signal failed: ${reason})`;
      }
    }
    // no channel (or the runner has no cancel hook) — legacy stop-polling
    fire({ type: 'cancel-no-channel', taskName: ar.task.name, runId });
    return '';
  }

  async function finishAsyncRun(runId: string, ar: AsyncRun, poll: TerminalPollResult): Promise<void> {
    if (ar.finishing) return; // cancelRun claimed the run while this tick's snapshot was in flight — it finishes it
    ar.finishing = true;
    const finishedAt = clock();
    if (ar.schedule !== null) {
      await completeScheduleRun(ar.schedule, ar.task, runId, poll, finishedAt);
    } else {
      await recordFinish(ar.task.name, runId, poll, ar.task.retryCount + 1, true); // manual trigger — schedule untouched
      // r6 F5: reflect the manual run on the task (lastRunId/lastRunAt) without moving the schedule
      await storage.completeTask(ar.task.name, {
        nextRunAt: ar.task.nextRunAt,
        lastRunAt: finishedAt,
        failed: poll.status === 'failed',
        lastRunId: runId,
      });
    }
    asyncRuns.delete(runId);
  }

  /** Async branch: `accepted` from the runner → queued + poll queue. Returns false when the
   * runner contract was violated (accepted without `poll()`) and the run was failed fast. */
  async function startAsyncRun(
    runId: string,
    task: TaskRecord,
    schedule: ScheduleRecord | null,
    accepted: Extract<RunOutcome, { status: 'accepted' }>,
  ): Promise<boolean> {
    if (!runner.poll) {
      // fail-fast: accepted without a poll implementation is a contract violation
      const failure: SyncOutcome = {
        status: 'failed',
        error: `runner '${task.runner}' returned accepted but has no poll()`,
      };
      if (schedule !== null) {
        await completeScheduleRun(schedule, task, runId, failure, clock(), { retry: false }); // config bug — deterministic
      } else {
        await recordFinish(task.name, runId, failure, task.retryCount + 1, true);
        await storage.completeTask(task.name, {
          nextRunAt: task.nextRunAt,
          lastRunAt: clock(),
          failed: true,
          lastRunId: runId,
        });
      }
      return false;
    }
    await storage.updateRun(runId, { status: 'queued', workerRef: accepted.statusUrl });
    const at = clock().getTime();
    asyncRuns.set(runId, {
      task,
      schedule,
      statusUrl: accepted.statusUrl,
      cancelUrl: accepted.cancelUrl ?? null,
      cancelSignaled: false,
      finishing: false,
      pollIntervalMs: accepted.pollIntervalMs,
      nextPollAt: at + accepted.pollIntervalMs,
      acceptedAt: at,
    });
    return true;
  }

  let polling = false;
  async function pollOnce(now: Date): Promise<void> {
    if (polling) return; // non-reentrant: a slow network poll must never stack (double-finish)
    polling = true;
    try {
      await pollOnceInner(now);
    } catch (err) {
      // Prod defect 1 (books post-cutover 2026-08-22): a mongo connection drop
      // rejects the in-flight storage op (the driver reconnects on its own, but
      // the op that hit the gap throws MongoNetworkError). The daemon's interval
      // calls are `void pollOnce()` — an unhandled rejection would crash Node 24.
      // Same boundary as tick(): fire an error event, keep the loop alive.
      fire({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      polling = false;
    }
  }

  async function pollOnceInner(now: Date): Promise<void> {
    const at = now.getTime();
    for (const [runId, ar] of [...asyncRuns]) {
      if (ar.nextPollAt > at) continue;
      // Per-task run-deadline (task.timeoutMs): >0 = force-fail at the task's
      // own ceiling (overrides the global); -1 = never auto-terminate (only
      // manual cancel) — tasks.json absent now defaults to -1 at parse; null
      // = a legacy DB row not yet re-synced → the engine's global
      // pollTimeoutMs. Measured from acceptance (≈ run start for async).
      const taskTimeout = ar.task.timeoutMs ?? null;
      if (taskTimeout === -1) {
        // never auto-terminate — skip the global ceiling too
      } else if (taskTimeout !== null) {
        if (at - ar.acceptedAt >= taskTimeout) {
          const cancelError = await signalCancel(runId, ar);
          await finishAsyncRun(runId, ar, { status: 'failed', error: `run timeout after ${taskTimeout}ms${cancelError}` });
          continue;
        }
      } else if (pollTimeoutMs > 0 && at - ar.acceptedAt >= pollTimeoutMs) {
        const cancelError = await signalCancel(runId, ar);
        await finishAsyncRun(runId, ar, { status: 'failed', error: `poll timeout after ${pollTimeoutMs}ms${cancelError}` });
        continue;
      }
      let poll: PollResult;
      try {
        poll = await runner.poll!(runId, ar.statusUrl, ar.task);
      } catch (err) {
        await finishAsyncRun(runId, ar, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      fire({ type: 'poll', taskName: ar.task.name, runId, status: poll.status, progress: poll.progress ?? null });
      if (poll.status === 'succeeded' || poll.status === 'failed') {
        await finishAsyncRun(runId, ar, poll);
      } else {
        // intermediate: apply progress/log, keep polling
        await storage.updateRun(runId, {
          status: poll.status,
          progress: poll.progress ?? null,
          log: poll.log ?? null,
          result: poll.result ?? null,
        });
        ar.nextPollAt = at + ar.pollIntervalMs;
      }
    }
  }

  async function runSchedule(schedule: ScheduleRecord, task: TaskRecord, now: Date): Promise<void> {
    // Pause AND (decision 2026-08-18): a run fires iff !task.paused &&
    // !schedule.paused. The due query filters schedule.paused; the task flag is
    // the family stop (repair window) — checked here at dispatch (and the
    // atomic claim stays race-free against it).
    if (task.paused || schedule.paused) return;
    const claimed = await storage.claimSchedule(schedule.id, now);
    if (!claimed) return; // lost the race (locked / paused / disabled / sibling of same task in flight)

    // missed-slot: a schedule with history dispatching way past its slot means
    // the slot was lost (engine down / wedged lock) — the catch-up run is not
    // the on-time one. Cause-agnostic by design; grace is configurable.
    if (
      schedule.lastRunAt !== null &&
      schedule.nextRunAt !== null &&
      now.getTime() - schedule.nextRunAt.getTime() > missedSlotGraceMs
    ) {
      fire({
        type: 'missed-slot',
        taskName: task.name,
        scheduleId: schedule.id,
        runner: task.runner,
        scheduledAt: schedule.nextRunAt,
        delayMs: now.getTime() - schedule.nextRunAt.getTime(),
      });
    }

    // Lock heartbeat: armed on claim, stopped on finish (finally) — a long
    // sync run survives lockTtlMs. Async runs handed to the poll queue are
    // covered by the pollTimeoutMs < lockTtlMs invariant instead (the poll
    // fails the run before the watchdog could reap its lock).
    const stopHeartbeat = startHeartbeat(schedule.id);
    // Cancel registry entry: declared OUTSIDE the try so the finally can see it
    // (let/const are try-block-scoped — a finally cannot read them).
    const runId = randomUUID();
    const controller = new AbortController();
    let runFinished!: () => void;
    const runDone = new Promise<void>((r) => (runFinished = r));
    runningRuns.set(runId, { controller, done: runDone });
    const deadline = armRunDeadline(task, controller);
    try {
      fire({ type: 'claim', taskName: task.name, runId, attempt: schedule.retryCount + 1 });
      const startedAt = now;
      await storage.createRun({
        id: runId,
        taskName: task.name,
        runner: task.runner,
        startedAt,
        finishedAt: null,
        status: 'running',
        // the run takes its parameters FROM THE SCHEDULE (slice 2); a schedule
        // without data falls back to the task's defaults (v1 parity).
        data: schedule.data ?? task.config.data ?? task.config.body ?? null,
        result: null,
        error: null,
        progress: null,
        log: null,
        artifacts: null,
        workerRef: null,
        attempt: schedule.retryCount + 1,
        trigger: 'schedule',
        triggeredBy: null,
        scheduleId: schedule.id, // audit: which schedule shot — per-tenant usage falls out of it
        temporary: false,
        // retry-linking: a run dispatched while a retry is pending is a retry of
        // the previous finished run (schedule.lastRunId written at its finish).
        retryOf: schedule.retryCount > 0 ? schedule.lastRunId : null,
      });

      let outcome: RunOutcome;
      fire({ type: 'dispatch', taskName: task.name, runId, runner: task.runner, attempt: schedule.retryCount + 1 });
      try {
        // dispatch view: the runner sees the schedule's data as the payload
        // (config.data/body overridden when the schedule carries data).
        outcome = await runner.run(dispatchView(task, schedule.data), runId, startedAt, {
          onProgress: (p) => reportProgress(runId, p),
          signal: controller.signal,
        });
      } catch (err) {
        // A throwing runner is a failed run, never a crashed engine; an
        // AbortError (user cancel) is a cancelled run.
        outcome = outcomeFromThrow(err);
      }
      outcome = applyRunDeadline(outcome, deadline, task.timeoutMs ?? 0);

      if (outcome.status === 'accepted') {
        await startAsyncRun(runId, task, schedule, outcome);
        return; // schedule stays claimed; poll loop completes it
      }

      const finishedAt = clock();
      await completeScheduleRun(schedule, task, runId, outcome, finishedAt);
    } finally {
      deadline.dispose();
      stopHeartbeat();
      runningRuns.delete(runId);
      runFinished();
    }
  }

  async function tick(now: Date): Promise<void> {
    if (ticking) return; // non-reentrant: never stack ticks
    ticking = true;
    try {
      const due = await storage.listDueSchedules(now);
      if (due.length > 0) fire({ type: 'tick', at: now, dueCount: due.length });
      // Batches of maxConcurrent, priority-ordered (storage sorts priority DESC).
      // Claims stay atomic per schedule — parallelism never overlaps one task
      // (per-task ceiling 1 is enforced by the storage claim).
      for (let i = 0; i < due.length; i += maxConcurrent) {
        const batch = due.slice(i, i + maxConcurrent);
        await Promise.all(
          batch.map(async (schedule) => {
            const task = await storage.getTask(schedule.taskName);
            if (!task) return; // schedule survived but its task is gone — nothing to dispatch
            await runSchedule(schedule, task, now);
          }),
        );
      }
    } catch (err) {
      // Error boundary: a storage/runner failure must not kill the loop silently —
      // the watchdog + retries handle the run; the daemon keeps ticking.
      fire({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      ticking = false;
    }
  }

  /** Watchdog pass: reap zombie locks (task + schedule), emit an event only when something was reaped. */
  async function reap(olderThan: Date): Promise<void> {
    try {
      const count =
        (await storage.reapZombieLocks(olderThan)) + (await storage.reapZombieScheduleLocks(olderThan));
      if (count > 0) fire({ type: 'zombie-reaped', olderThan, count });
    } catch (err) {
      // Prod defect 1: a transient storage failure (mongo reconnect window) must
      // never crash the daemon — fire an error event and let the next pass retry.
      fire({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Retention pass — prune terminal runs past their class TTL (see runRetentionOnce). */
  async function retentionOnce(now: Date): Promise<void> {
    // Prod defect 6 (books post-cutover 2026-08-22): 0 = retention disabled —
    // the operator must be able to keep run history as an archive. Defaults
    // remain 30d / 24h when the config value is omitted.
    if (retentionMs <= 0 && temporaryRetentionMs <= 0) return;
    try {
      const removed =
        (temporaryRetentionMs > 0
          ? await storage.pruneRuns({ olderThan: new Date(now.getTime() - temporaryRetentionMs), temporary: true })
          : 0) +
        (retentionMs > 0
          ? await storage.pruneRuns({ olderThan: new Date(now.getTime() - retentionMs), temporary: false })
          : 0);
      if (removed > 0) {
        fire({
          type: 'retention-pruned',
          olderThanTemporary: new Date(now.getTime() - temporaryRetentionMs),
          olderThanRegular: new Date(now.getTime() - retentionMs),
          removed,
        });
      }
    } catch (err) {
      // Prod defect 1: a transient storage failure must not crash the daemon.
      fire({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    async runOnce(now) {
      await tick(now ?? clock());
    },

    async triggerTask(name, opts, now) {
      const at = now ?? clock();
      const task = await storage.getTask(name);
      if (!task) return null;

      const runId = randomUUID();
      let merged = mergeRunData(task.config.data ?? task.config.body ?? null, opts?.data);
      // task:1658 — run_once validation: the merged data must match the task's
      // inputSchema (defaults applied; the run records the EFFECTIVE data, so
      // the worker and the record always agree). A mismatch is a caller error —
      // throw (the admin API maps it to 400 with details).
      if (task.inputSchema !== null && task.inputSchema !== undefined) {
        const res = validateInput(task.inputSchema as Record<string, unknown>, merged);
        if (!res.ok) throw new InputValidationError(res.issues);
        merged = res.data;
      }
      await storage.createRun({
        id: runId,
        taskName: name,
        runner: task.runner,
        startedAt: at,
        finishedAt: null,
        status: 'running',
        data: merged,
        result: null,
        error: null,
        progress: null,
        log: null,
        artifacts: null,
        workerRef: null,
        attempt: task.retryCount + 1,
        trigger: 'manual',
        triggeredBy: opts?.triggeredBy ?? null,
        scheduleId: null, // manual runs never carry a schedule
        temporary: opts?.temporary ?? false,
        retryOf: null,
      });

      let outcome: RunOutcome;
      fire({ type: 'dispatch', taskName: name, runId, runner: task.runner, attempt: task.retryCount + 1 });
      const controller = new AbortController();
      let runFinished!: () => void;
      const runDone = new Promise<void>((r) => (runFinished = r));
      runningRuns.set(runId, { controller, done: runDone });
      const deadline = armRunDeadline(task, controller);
      try {
        // dispatch view: only an actual override rewrites the payload — a run that
        // fell back to task defaults dispatches the raw task (body untouched),
        // mirroring the schedule path. The worker receives the MERGED data
        // (base + override), so the run record and the worker always agree.
        outcome = await runner.run(
          dispatchView(task, opts?.data !== undefined ? merged : undefined),
          runId,
          at,
          {
            onProgress: (p) => reportProgress(runId, p),
            signal: controller.signal,
          },
        );
      } catch (err) {
        outcome = outcomeFromThrow(err);
      } finally {
        deadline.dispose();
        runningRuns.delete(runId);
        runFinished();
      }
      outcome = applyRunDeadline(outcome, deadline, task.timeoutMs ?? 0);

      if (outcome.status === 'accepted') {
        const enqueued = await startAsyncRun(runId, task, null, outcome);
        if (enqueued) {
          // trigger: schedule untouched, no claim to release — poll only finishes the run
          return storage.getRun(runId);
        }
        // accepted without poll(): run was failed fast — report it like any sync outcome
        return storage.getRun(runId);
      }

      const finishedAt = clock();
      // manual trigger: never auto-retries, alerts immediately, schedule untouched
      await recordFinish(name, runId, outcome, task.retryCount + 1, true);
      // r6 F5: reflect the manual run on the task (lastRunId/lastRunAt) without moving the schedule
      await storage.completeTask(task.name, {
        nextRunAt: task.nextRunAt,
        lastRunAt: finishedAt,
        failed: outcome.status === 'failed',
        lastRunId: runId,
      });
      return storage.getRun(runId);
    },

    async retryRun(runId, opts, now) {
      const at = now ?? clock();
      const original = await storage.getRun(runId);
      if (!original) return null;
      const task = await storage.getTask(original.taskName);
      if (!task) return null; // run survived but its task is gone — nothing to execute

      const newRunId = randomUUID();
      await storage.createRun({
        id: newRunId,
        taskName: original.taskName,
        runner: task.runner,
        startedAt: at,
        finishedAt: null,
        status: 'running',
        data: original.data,
        result: null,
        error: null,
        progress: null,
        log: null,
        artifacts: null,
        workerRef: null,
        attempt: task.retryCount + 1,
        trigger: 'manual',
        triggeredBy: opts?.triggeredBy ?? null,
        scheduleId: null, // manual retries are not schedule-fired
        temporary: original.temporary, // retention class inherited from the original
        retryOf: original.id, // predecessor — the run being retried
      });

      let outcome: RunOutcome;
      fire({ type: 'dispatch', taskName: original.taskName, runId: newRunId, runner: task.runner, attempt: task.retryCount + 1 });
      const controller = new AbortController();
      let runFinished!: () => void;
      const runDone = new Promise<void>((r) => (runFinished = r));
      runningRuns.set(newRunId, { controller, done: runDone });
      const deadline = armRunDeadline(task, controller);
      try {
        // dispatch view: a retry carries the original run's data (decision 6), not
        // the task defaults — same view the original was dispatched with.
        outcome = await runner.run(dispatchView(task, original.data), newRunId, at, {
          onProgress: (p) => reportProgress(newRunId, p),
          signal: controller.signal,
        });
      } catch (err) {
        outcome = outcomeFromThrow(err);
      } finally {
        deadline.dispose();
        runningRuns.delete(newRunId);
        runFinished();
      }
      outcome = applyRunDeadline(outcome, deadline, task.timeoutMs ?? 0);

      if (outcome.status === 'accepted') {
        const enqueued = await startAsyncRun(newRunId, task, null, outcome);
        if (enqueued) {
          return storage.getRun(newRunId);
        }
        return storage.getRun(newRunId);
      }

      const finishedAt = clock();
      // manual retry: schedule untouched, never auto-retries, alerts immediately
      await recordFinish(original.taskName, newRunId, outcome, task.retryCount + 1, true);
      return storage.getRun(newRunId);
    },

    async cancelRun(runId) {
      const run = await storage.getRun(runId);
      if (!run) return null;

      // Async pull run (queued or running-async, still being polled): drop it
      // from the poll queue and finish cancelled — schedule advanced, lock
      // released (same terminal path as a normal poll finish).
      const ar = asyncRuns.get(runId);
      if (ar) {
        asyncRuns.delete(runId);
        ar.finishing = true; // claimed: a stale poll-tick snapshot must not double-finish
        const finishedAt = clock();
        // Tell the worker to stop BEFORE finishing cancelled — the accepted
        // envelope's cancelUrl is the worker's cancel channel (the http runner
        // POSTs {runId}; the worker stops at the next stage boundary). A
        // worker without a cancelUrl, or a failed signal, is left to finish on
        // its own — the run's error records that honestly instead of silently
        // orphaning the worker (battle-stand report 2026-08-21: cancel did not
        // reach the worker, which kept publishing after cancel). Each step
        // fires a cancel-* event so stdout shows where a signal gets lost.
        const cancelError = await signalCancel(runId, ar);
        const cancelled: SyncOutcome = { status: 'cancelled', error: `cancelled by user${cancelError}` };
        if (ar.schedule !== null) {
          await completeScheduleRun(ar.schedule, ar.task, runId, cancelled, finishedAt);
        } else {
          await recordFinish(ar.task.name, runId, cancelled, ar.task.retryCount + 1, true);
        }
        return storage.getRun(runId);
      }

      // Sync run in flight: abort the runner via hooks.signal and AWAIT the
      // actual stop — the run comes back cancelled (built-in runners react to
      // abort; a non-abortable custom runner keeps the run hanging, which is
      // what cancel is for).
      const entry = runningRuns.get(runId);
      if (entry) {
        entry.controller.abort();
        await entry.done;
        return storage.getRun(runId);
      }

      // Terminal (or present-but-not-in-flight) run — nothing to cancel.
      return storage.getRun(runId);
    },

    async runWatchdogOnce(now) {
      const at = now ?? clock();
      await reap(new Date(at.getTime() - lockTtlMs));
    },

    async runPollOnce(now) {
      await pollOnce(now ?? clock());
    },

    async runRetentionOnce(now) {
      await retentionOnce(now ?? clock());
    },

    async recoverOrphanRuns(now) {
      const at = now ?? clock();
      const orphans = [];
      for (const status of ['running', 'queued'] as const) {
        orphans.push(...(await storage.listRuns({ status })));
      }
      for (const run of orphans) {
        await storage.finishRun(run.id, {
          status: 'cancelled',
          error: 'daemon restarted — orphaned run recovered',
        });
      }
      const clearedLocks = (await storage.clearLocks()) + (await storage.clearScheduleLocks());
      if (orphans.length > 0 || clearedLocks > 0) {
        fire({ type: 'recovered-orphans', count: orphans.length, clearedLocks });
      }
      return orphans.length;
    },

    start() {
      tickTimer = setInterval(() => {
        void tick(clock());
      }, tickIntervalMs);
      watchdogTimer = setInterval(() => {
        void reap(new Date(clock().getTime() - lockTtlMs));
      }, watchdogIntervalMs);
      pollTimer = setInterval(() => {
        void pollOnce(clock());
      }, pollIntervalMs);
      retentionTimer = setInterval(() => {
        void retentionOnce(clock());
      }, retentionIntervalMs);
    },

    stop() {
      if (tickTimer) clearInterval(tickTimer);
      if (watchdogTimer) clearInterval(watchdogTimer);
      if (pollTimer) clearInterval(pollTimer);
      if (retentionTimer) clearInterval(retentionTimer);
      tickTimer = null;
      watchdogTimer = null;
      pollTimer = null;
      retentionTimer = null;
    },
  };
}
