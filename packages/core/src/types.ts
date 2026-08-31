import type { Schedule } from './human.js';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** How a run was launched. `'schedule'` = tick; `'manual'` = triggerTask / retry. */
export type RunTrigger = 'schedule' | 'manual';

/**
 * Per-task retry policy (engine feature — retries are the foundation of the
 * AI-operator trigger: a *persistent* failure is one where retries ran out).
 * On a failed run with retries left, the engine schedules another attempt
 * `backoffMs` (× `multiplier` per consumed retry) later and does NOT fire
 * onRunFinal — the alert only lands on the final, exhausted failure.
 */
export interface RetryPolicy {
  /** Total attempts allowed (1 = no retries). Must be ≥ 1. */
  maxAttempts: number;
  /** Fixed delay before the first retry, ms. Must be ≥ 0. */
  backoffMs: number;
  /** Backoff growth per consumed retry (1 = fixed). Must be ≥ 1. */
  multiplier?: number;
}

/**
 * Reference to a run artifact — S3 object, email receipt, URL, local file.
 * Worker reports them back; the daemon stores them on the RunRecord.
 */
export interface ArtifactRef {
  kind: 's3' | 'email' | 'url' | 'file';
  /** e.g. `s3://bucket/key`, an email message id, a URL, a file path. */
  ref: string;
  label: string | null;
}

/**
 * One schedule instance of a task — «when + with what parameters». The task
 * is the template («what/how to run»); a schedule is one concrete firing rule
 * with its own `data`/policy (books pain: `idSeller` per seller — one task,
 * N schedules, one per tenant). Runs launched by a schedule carry its id in
 * `RunRecord.scheduleId` (audit: which schedule fired).
 *
 * Runtime state (nextRunAt/lastRunAt/failCount/retryCount/lock) lives HERE,
 * on the schedule row. The task row keeps the engine-facing primary schedule
 * until the engine moves to schedule rows (slice 2 of schedule-as-entity).
 */
export interface ScheduleRecord {
  /**
   * Stable identity. Declarative (tasks.json): task name for a single
   * schedule, `${taskName}#${index}` for multiple (idempotent re-sync).
   * Imperative (admin API): UUID. Migration synthesis: task name.
   */
  id: string;
  /** The task this schedule instantiates. */
  taskName: string;
  /** Firing rule — always present (a schedule without one is meaningless). */
  schedule: Schedule;
  /** IANA timezone for cron wall-clock semantics. Default: 'UTC'. */
  tz: string;
  /** Run parameters — a schedule-fired run dispatches with THIS data. */
  data: unknown | null;
  /** Tenant key (userId/orgId) — multi-tenancy: many schedules per task, per-tenant isolation. */
  externalId: string | null;
  /**
   * Idempotent upsert key for imperative schedules: a second createSchedule
   * with the same dedupKey updates the existing row (no duplicate). Migration
   * synthesis uses dedupKey = task name. UNIQUE across schedules.
   */
  dedupKey: string | null;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  /** Set while a schedule-fired run is in flight (claimed); cleared on completion. */
  lockedAt: Date | null;
  failCount: number;
  /** Scheduling priority: higher runs first among due schedules. Default: 0. */
  priority: number;
  /** Retry policy override; null = inherit the task's policy (slice 3 resolution). */
  retry: RetryPolicy | null;
  /** Retries consumed so far (runtime state; 0 = none). */
  retryCount: number;
  /** Id of the last finished run from this schedule (runtime state). */
  lastRunId: string | null;
  paused: boolean;
  disabled: boolean;
  /**
   * True/absent = managed by tasks.json (sync disables it when removed from
   * the file); false = runtime-registered (admin API) — sync never disables it.
   */
  fileManaged?: boolean;
}

/** A scheduled task as stored by the engine. */
export interface TaskRecord {
  name: string;
  /** Runner name — the daemon dispatches to the implementation registered for it. Default: 'http'. */
  runner: string;
  /** Scheduling rule; null = trigger-only task (never due, launched manually / from the API). */
  schedule: Schedule | null;
  /** IANA timezone for cron wall-clock semantics. Default: 'UTC'. */
  tz: string;
  /** Runner-specific config (e.g. HTTP url/method/headers) — opaque to the engine. */
  config: Record<string, unknown>;
  /**
   * JSON Schema for run `data` (tenant params) — task:1658. Declares types/
   * bounds/defaults/descriptions; the engine validates `data` at run_once and
   * schedule create/update (400 with details), applies defaults, and the UI/
   * MCP render forms from it (trigger.dev model). Null = no schema (any data).
   */
  inputSchema?: unknown | null;
  /** Human-readable label (admin UI). Ignored by the engine. */
  label: string | null;
  /** Longer description (admin UI). Ignored by the engine. */
  description: string | null;
  /** Next planned run; null = not scheduled (e.g. one-shot already fired). */
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  /** Set while a run is in flight (claimed); cleared on completion / zombie reap. */
  lockedAt: Date | null;
  failCount: number;
  /** Scheduling priority: higher runs first among due tasks. Default: 0. */
  priority: number;
  /** Retry policy; null = no retries (a failure is final). */
  retry: RetryPolicy | null;
  /** Retries consumed so far (runtime state; 0 = none). */
  retryCount: number;
  /**
   * Id of the last finished run (runtime state; engine writes it at every
   * finish). Retry-linking: an engine auto-retry run gets `retryOf = lastRunId`.
   */
  lastRunId: string | null;
  /**
   * Run-deadline contract: force-termination timeout in ms from run start.
   * `-1` = never auto-terminate (only manual cancel; the tasks.json default
   * when the field is omitted); `> 0` = force-fail the run after this many ms;
   * `null` = a legacy DB row not yet re-synced (async runs capped by the
   * engine's global `pollTimeoutMs`, sync runs uncapped).
   */
  timeoutMs?: number | null;
  /**
   * True/absent = managed by tasks.json (sync may disable it when removed from
   * the file); false = runtime-registered (`POST /tasks`) — sync never disables
   * it (r7 F1).
   */
  fileManaged?: boolean;
  paused: boolean;
  disabled: boolean;
}

/**
 * One execution attempt of a task (v2 — runner protocol).
 *
 * The daemon owns run history (Model A): everything a worker reports back
 * (result/log/progress/artifacts/workerRef) is stored here. `data` is the
 * snapshot of run parameters taken at start (from tasks.json `data`/`config.body`).
 *
 * Status lifecycle: queued (accepted, awaiting poll) → running → succeeded|failed|cancelled.
 */
export interface RunRecord {
  id: string;
  taskName: string;
  /** Runner name this run was dispatched to ('http' | 'docker' | custom). */
  runner: string;
  status: RunStatus;
  /** Run parameters snapshot (JSON-serializable). */
  data: unknown | null;
  /** Final result reported by the worker (JSON-serializable). */
  result: unknown | null;
  error: string | null;
  /** 0-100; written mid-flight by the poll loop / the task itself. */
  progress: number | null;
  /** Captured stdout/stderr, soft-capped. */
  log: string | null;
  artifacts: ArtifactRef[] | null;
  /** statusUrl (http) / container_id (docker) — debugging handle. */
  workerRef: string | null;
  /** Attempt number within the retry cycle (1 = first try). */
  attempt: number;
  /** How this run was launched — the tick ('schedule') or an explicit trigger/retry ('manual'). */
  trigger: RunTrigger;
  /** Who launched a manual run (email/identity); caller-supplied. Null for schedule runs and the sched admin api. */
  triggeredBy: string | null;
  /**
   * Id of the schedule that fired this run; null = manual/trigger run.
   * Audit: «which schedule shot» — per-tenant usage counting falls out of it.
   */
  scheduleId: string | null;
  /**
   * Retention class: true → short TTL (default 24h), false → long (default 30d).
   * Per-invocation, not per-task. Manual retries inherit the original's class.
   */
  temporary: boolean;
  /** Predecessor run id: the retried run (manual retry) or the failed attempt (engine auto-retry). Null = fresh. */
  retryOf: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}
