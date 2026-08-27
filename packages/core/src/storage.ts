import type { ArtifactRef, RetryPolicy, RunRecord, RunStatus, ScheduleRecord, TaskRecord } from './types.js';

export interface CompleteResult {
  /** Next planned run after this one (null = schedule exhausted, e.g. one-shot). */
  nextRunAt: Date | null;
  lastRunAt: Date;
  /** True → failCount is incremented by the storage. */
  failed: boolean;
  /**
   * Absolute retryCount to persist (engine passes 0 on success / final failure,
   * consumed+1 on a retry). Omitted → storage leaves the current value.
   */
  retryCount?: number;
  /**
   * Id of the finished run — stored on the task for engine auto-retry linking
   * (`retryOf = task.lastRunId`). Omitted → storage leaves the current value.
   */
  lastRunId?: string | null;
}

export interface RunUpdate {  /** Partial mid-flight update (poll loop, worker heartbeat). Never terminal. */
  status?: RunStatus;
  error?: string | null;
  result?: unknown | null;
  progress?: number | null;
  log?: string | null;
  artifacts?: ArtifactRef[] | null;
  workerRef?: string | null;
}

export interface RunFilter {
  taskName?: string;
  status?: RunStatus;
  limit?: number;
  offset?: number;
}

/** Retention sweep filter — deletes only terminal runs finished before `olderThan`. */
export interface PruneRunsFilter {
  /** Delete runs whose `finishedAt` is strictly before this moment. */
  olderThan: Date;
  /** Which retention class to prune: true = temporary (short TTL), false = regular (long TTL). */
  temporary: boolean;
}

/** Pagination for task lists (ordered by name ASC). */
export interface TaskListFilter {
  limit?: number;
  offset?: number;
}

/** Pagination/filter for schedule lists (ordered by id ASC). */
export interface ScheduleListFilter {
  /** Restrict to one task's schedules. */
  taskName?: string;
  limit?: number;
  offset?: number;
}

/** Terminal update — storage sets `finishedAt` itself. */
export interface RunFinish {
  status: RunStatus;
  error?: string | null;
  result?: unknown | null;
  progress?: number | null;
  log?: string | null;
  artifacts?: ArtifactRef[] | null;
}

/**
 * Storage seam for the scheduler engine. The engine core (tick loop, watchdog,
 * state machine) depends only on this interface — adapters provide SQLite
 * (node:sqlite), and later MariaDB / Postgres. All methods are async so
 * network-backed adapters can be added without changing the core.
 *
 * Contract: `packages/core/test/storage-contract.ts` — every adapter must pass it.
 */
export interface Storage {
  // --- tasks ---
  upsertTask(task: TaskRecord): Promise<void>;
  getTask(name: string): Promise<TaskRecord | null>;
  /** List tasks, ordered by name ASC; paginated with limit/offset (limit capped at 1000). */
  listTasks(filter?: TaskListFilter): Promise<TaskRecord[]>;
  deleteTask(name: string): Promise<void>;

  // --- tick loop ---
  /** Tasks due at `now`: nextRunAt <= now, unlocked, unpaused, enabled. Ordered by nextRunAt ASC. */
  listDueTasks(now: Date): Promise<TaskRecord[]>;
  /** Atomically lock a task for execution. Returns false if already locked / paused / disabled. */
  claimTask(name: string, now: Date): Promise<boolean>;
  /** Clear the lock and advance next/last run; increments failCount when `failed`. */
  completeTask(name: string, result: CompleteResult): Promise<void>;
  /** Unlock tasks whose lock is older than `olderThan` (zombie sweep); increments their failCount. Returns count. */
  reapZombieLocks(olderThan: Date): Promise<number>;
  /**
   * Release every task lock immediately (startup recovery). Unlike
   * `reapZombieLocks` it does NOT touch failCount — an interrupted run is an
   * infrastructure event, not a task failure. Returns the number of locks cleared.
   */
  clearLocks(): Promise<number>;
  /**
   * Extend a claimed task's lock (heartbeat). A long in-flight run calls this
   * periodically so the zombie watchdog never reaps a live lock. No-op when the
   * task is not currently locked — never re-locks a reaped/finished task.
   */
  refreshLock(name: string, now: Date): Promise<void>;

  // --- schedules ---
  /**
   * Create a schedule, or — when `schedule.dedupKey` matches an existing row —
   * update that row in place (id preserved; the second create with the same
   * key is an update, never a duplicate). Returns the stored schedule; a
   * caller that needs created-vs-updated compares the returned id.
   */
  createSchedule(schedule: ScheduleRecord): Promise<ScheduleRecord>;
  getSchedule(id: string): Promise<ScheduleRecord | null>;
  /** Partial mid-life update (pause/resume, policy edits). Idempotent no-op for an unknown id. */
  updateSchedule(id: string, patch: Partial<ScheduleRecord>): Promise<void>;
  /** Delete a schedule. Idempotent no-op for an unknown id. */
  deleteSchedule(id: string): Promise<void>;
  /** List schedules, ordered by id ASC; optional taskName filter, paginated with limit/offset. */
  listSchedules(filter?: ScheduleListFilter): Promise<ScheduleRecord[]>;

  // --- schedule tick loop (slice 2: the engine drives schedules, not task rows) ---
  /**
   * Schedules due at `now`: nextRunAt <= now, unlocked, unpaused, enabled — and
   * PER-TASK CEILING: no other schedule of the same task may be locked (a task
   * never runs twice; its schedules are serialized). Ordered by effective
   * priority DESC (schedule priority, falling back to the task's), then
   * nextRunAt ASC.
   */
  listDueSchedules(now: Date): Promise<ScheduleRecord[]>;
  /**
   * Atomically lock a schedule for execution. Returns false when already
   * locked / paused / disabled — or when another schedule of the same task is
   * locked (per-task ceiling 1, atomic — the race-safe twin of listDueSchedules).
   */
  claimSchedule(id: string, now: Date): Promise<boolean>;
  /** Clear the schedule lock and advance its next/last run; increments failCount when `failed`. */
  completeSchedule(id: string, result: CompleteResult): Promise<void>;
  /** Unlock stale schedule locks (zombie sweep); increments their failCount. Returns count. */
  reapZombieScheduleLocks(olderThan: Date): Promise<number>;
  /**
   * Extend a claimed schedule's lock (heartbeat) — no-op when not locked.
   * The schedule twin of `refreshLock`.
   */
  refreshScheduleLock(id: string, now: Date): Promise<void>;
  /** Release every schedule lock immediately (startup recovery). Returns count. */
  clearScheduleLocks(): Promise<number>;

  // --- run history ---
  createRun(run: RunRecord): Promise<void>;
  getRun(runId: string): Promise<RunRecord | null>;
  /** Partial update during a run: poll progress/log, workerRef, result as it arrives. */
  updateRun(runId: string, patch: RunUpdate): Promise<void>;
  /** Terminal update: sets status + finishedAt, optionally carrying result/log/progress/artifacts. */
  finishRun(runId: string, finish: RunFinish): Promise<void>;
  /** Delete a run record (admin cleanup / retention). No-op for unknown run. */
  deleteRun(runId: string): Promise<void>;
  /** List runs, newest first; filters by task/status, paginated with limit/offset. */
  listRuns(filter?: RunFilter): Promise<RunRecord[]>;
  /**
   * Retention sweep: delete terminal runs (`succeeded|failed|cancelled`) of one
   * retention class (`temporary` true/false) finished before `olderThan`.
   * Non-terminal runs are the watchdog's job, not the sweeper's. Returns count.
   */
  pruneRuns(filter: PruneRunsFilter): Promise<number>;
}
