import { DatabaseSync } from 'node:sqlite';
import type { Schedule } from './human.js';
import type {
  CompleteResult,
  RunFilter,
  RunFinish,
  RunUpdate,
  ScheduleListFilter,
  Storage,
  TaskListFilter,
} from './storage.js';
import type { ArtifactRef, RetryPolicy, RunRecord, RunStatus, ScheduleRecord, TaskRecord } from './types.js';

interface TaskRow {
  name: string;
  runner: string;
  schedule_json: string;
  tz: string;
  config_json: string;
  label: string | null;
  description: string | null;
  next_run_at: number | null;
  last_run_at: number | null;
  locked_at: number | null;
  fail_count: number;
  priority: number;
  retry_json: string | null;
  retry_count: number;
  last_run_id: string | null;
  timeout_ms: number | null;
  paused: number;
  disabled: number;
  file_managed: number;
  created_at: number;
  updated_at: number;
}

interface ScheduleRow {
  id: string;
  task_name: string;
  schedule_json: string;
  tz: string;
  data: string | null;
  external_id: string | null;
  dedup_key: string | null;
  next_run_at: number | null;
  last_run_at: number | null;
  locked_at: number | null;
  fail_count: number;
  priority: number;
  retry_json: string | null;
  retry_count: number;
  last_run_id: string | null;
  paused: number;
  disabled: number;
  file_managed: number;
  created_at: number;
  updated_at: number;
}

interface RunRow {
  id: string;
  task_name: string;
  runner: string;
  started_at: number;
  finished_at: number | null;
  status: string;
  data: string | null;
  result: string | null;
  error: string | null;
  progress: number | null;
  log: string | null;
  artifacts: string | null;
  worker_ref: string | null;
  attempt: number;
  trigger: string;
  triggered_by: string | null;
  schedule_id: string | null;
  temporary: number;
  retry_of: string | null;
}

const epoch = (d: Date | null): number | null => (d ? d.getTime() : null);
const date = (n: number | null): Date | null => (n === null ? null : new Date(n));
/** Safe JSON read: a corrupt row (foreign writer, manual edit) must never crash the tick. */
const json = (s: string | null): unknown => {
  if (s === null || s === undefined) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
const jsonString = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v));

function rowToTask(row: TaskRow): TaskRecord {
  return {
    name: row.name,
    runner: row.runner,
    schedule: json(row.schedule_json) as Schedule | null,
    tz: row.tz,
    config: json(row.config_json) as Record<string, unknown>,
    label: row.label,
    description: row.description,
    nextRunAt: date(row.next_run_at),
    lastRunAt: date(row.last_run_at),
    lockedAt: date(row.locked_at),
    failCount: row.fail_count,
    priority: row.priority,
    retry: row.retry_json === null ? null : (json(row.retry_json) as RetryPolicy),
    retryCount: row.retry_count,
    lastRunId: row.last_run_id,
    timeoutMs: row.timeout_ms,
    paused: row.paused === 1,
    disabled: row.disabled === 1,
    fileManaged: row.file_managed === 1,
  };
}

function rowToRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    taskName: row.task_name,
    runner: row.runner,
    startedAt: new Date(row.started_at),
    finishedAt: date(row.finished_at),
    status: row.status as RunStatus,
    data: json(row.data),
    result: json(row.result),
    error: row.error,
    progress: row.progress,
    log: row.log,
    artifacts: row.artifacts === null ? null : (json(row.artifacts) as ArtifactRef[]),
    workerRef: row.worker_ref,
    attempt: row.attempt,
    trigger: row.trigger as RunRecord['trigger'],
    triggeredBy: row.triggered_by,
    scheduleId: row.schedule_id,
    temporary: row.temporary === 1,
    retryOf: row.retry_of,
  };
}

function rowToSchedule(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    taskName: row.task_name,
    schedule: json(row.schedule_json) as Schedule,
    tz: row.tz,
    data: json(row.data),
    externalId: row.external_id,
    dedupKey: row.dedup_key,
    nextRunAt: date(row.next_run_at),
    lastRunAt: date(row.last_run_at),
    lockedAt: date(row.locked_at),
    failCount: row.fail_count,
    priority: row.priority,
    retry: row.retry_json === null ? null : (json(row.retry_json) as RetryPolicy),
    retryCount: row.retry_count,
    lastRunId: row.last_run_id,
    paused: row.paused === 1,
    disabled: row.disabled === 1,
    fileManaged: row.file_managed === 1,
  };
}

/** Non-id run column values in UPDATE binding order (18). */
function runValues(r: RunRecord): Array<string | number | null> {
  return [
    r.taskName,
    r.runner,
    r.startedAt.getTime(),
    epoch(r.finishedAt),
    r.status,
    jsonString(r.data),
    jsonString(r.result),
    r.error,
    r.progress,
    r.log,
    jsonString(r.artifacts),
    r.workerRef,
    r.attempt,
    r.trigger,
    r.triggeredBy,
    r.scheduleId,
    r.temporary ? 1 : 0,
    r.retryOf,
  ];
}

/** Non-id schedule column values in upsert binding order (19). */
function scheduleValues(s: ScheduleRecord): Array<string | number | null> {
  return [
    s.id,
    s.taskName,
    JSON.stringify(s.schedule),
    s.tz,
    jsonString(s.data),
    s.externalId ?? null,
    s.dedupKey ?? null,
    epoch(s.nextRunAt),
    epoch(s.lastRunAt),
    epoch(s.lockedAt),
    s.failCount,
    s.priority,
    s.retry === null ? null : JSON.stringify(s.retry),
    s.retryCount,
    s.lastRunId,
    s.paused ? 1 : 0,
    s.disabled ? 1 : 0,
    s.fileManaged === false ? 0 : 1,
    Date.now(),
    Date.now(),
  ];
}

/**
 * SQLite storage adapter over `node:sqlite` (built into Node ≥ 22.5 — zero
 * native dependencies, which is the "install in 60 seconds" product promise).
 *
 * Timestamps are stored as epoch milliseconds (INTEGER). Claim atomicity is a
 * conditional UPDATE whose `changes` count must be exactly 1 — safe on
 * single-replica, and the same shape scales to `SKIP LOCKED` when HA lands.
 */
export function createSqliteStorage(db: DatabaseSync): Storage {
  // v0.6 → v0.7 (schedule-as-entity, slice 1): schedules become first-class
  // rows. Detect whether the table exists BEFORE the CREATE below — the
  // synthesis of legacy task schedules must run exactly once (only when the
  // table is brand new), never on re-open of a v0.7 database.
  const hadSchedules =
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schedules'`).get() !== undefined;

  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      name          TEXT PRIMARY KEY,
      runner        TEXT NOT NULL DEFAULT 'http',
      schedule_json TEXT NOT NULL,
      tz            TEXT NOT NULL DEFAULT 'UTC',
      config_json   TEXT NOT NULL DEFAULT '{}',
      label         TEXT,
      description   TEXT,
      next_run_at   INTEGER,
      last_run_at   INTEGER,
      locked_at     INTEGER,
      fail_count    INTEGER NOT NULL DEFAULT 0,
      priority      INTEGER NOT NULL DEFAULT 0,
      retry_json    TEXT,
      retry_count   INTEGER NOT NULL DEFAULT 0,
      last_run_id   TEXT,
      timeout_ms    INTEGER,
      paused        INTEGER NOT NULL DEFAULT 0,
      disabled      INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id            TEXT PRIMARY KEY,
      task_name     TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      tz            TEXT NOT NULL DEFAULT 'UTC',
      data          TEXT,
      external_id   TEXT,
      dedup_key     TEXT UNIQUE,
      next_run_at   INTEGER,
      last_run_at   INTEGER,
      locked_at     INTEGER,
      fail_count    INTEGER NOT NULL DEFAULT 0,
      priority      INTEGER NOT NULL DEFAULT 0,
      retry_json    TEXT,
      retry_count   INTEGER NOT NULL DEFAULT 0,
      last_run_id   TEXT,
      paused        INTEGER NOT NULL DEFAULT 0,
      disabled      INTEGER NOT NULL DEFAULT 0,
      file_managed  INTEGER NOT NULL DEFAULT 1,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_runs (
      id          TEXT PRIMARY KEY,
      task_name   TEXT NOT NULL,
      runner      TEXT NOT NULL DEFAULT 'http',
      started_at  INTEGER NOT NULL,
      finished_at INTEGER,
      status      TEXT NOT NULL,
      data        TEXT,
      result      TEXT,
      error       TEXT,
      progress    INTEGER,
      log         TEXT,
      artifacts   TEXT,
      worker_ref  TEXT,
      attempt     INTEGER NOT NULL DEFAULT 1,
      trigger     TEXT NOT NULL DEFAULT 'schedule',
      triggered_by TEXT,
      schedule_id TEXT,
      temporary   INTEGER NOT NULL DEFAULT 0,
      retry_of    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_due ON scheduled_tasks (next_run_at);
    CREATE INDEX IF NOT EXISTS idx_runs_task ON task_runs (task_name, started_at);
    CREATE INDEX IF NOT EXISTS idx_schedules_task ON schedules (task_name);
  `);

  // v0.1 → v0.2 (format parity): add runner/label/description to existing DBs.
  const cols = db.prepare(`PRAGMA table_info(scheduled_tasks)`).all() as Array<{ name: string }>;
  const have = new Set(cols.map((c) => c.name));
  if (!have.has('runner')) db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN runner TEXT NOT NULL DEFAULT 'http'`);
  if (!have.has('label')) db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN label TEXT`);
  if (!have.has('description')) db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN description TEXT`);

  // v0.2 → v0.3 (runner protocol): add v2 run columns to existing DBs.
  const runCols = db.prepare(`PRAGMA table_info(task_runs)`).all() as Array<{ name: string }>;
  const haveRun = new Set(runCols.map((c) => c.name));
  if (!haveRun.has('runner')) db.exec(`ALTER TABLE task_runs ADD COLUMN runner TEXT NOT NULL DEFAULT 'http'`);
  if (!haveRun.has('data')) db.exec(`ALTER TABLE task_runs ADD COLUMN data TEXT`);
  if (!haveRun.has('result')) db.exec(`ALTER TABLE task_runs ADD COLUMN result TEXT`);
  if (!haveRun.has('progress')) db.exec(`ALTER TABLE task_runs ADD COLUMN progress INTEGER`);
  if (!haveRun.has('log')) db.exec(`ALTER TABLE task_runs ADD COLUMN log TEXT`);
  if (!haveRun.has('artifacts')) db.exec(`ALTER TABLE task_runs ADD COLUMN artifacts TEXT`);
  if (!haveRun.has('worker_ref')) db.exec(`ALTER TABLE task_runs ADD COLUMN worker_ref TEXT`);

  // v0.3 → v0.4 (embedded mode): priority/retry on tasks, attempt on runs.
  if (!have.has('priority')) db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`);
  if (!have.has('retry_json')) db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN retry_json TEXT`);
  if (!have.has('retry_count')) db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`);
  if (!haveRun.has('attempt')) db.exec(`ALTER TABLE task_runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1`);

  // v0.4 → v0.5 (run metadata parity): trigger/triggeredBy/temporary/retryOf on
  // runs, lastRunId on tasks. Backfill defaults (decision 9): trigger='schedule',
  // temporary=false, retryOf/triggeredBy NULL — history is not reconstructed.
  if (!have.has('last_run_id')) db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN last_run_id TEXT`);
  if (!haveRun.has('trigger')) db.exec(`ALTER TABLE task_runs ADD COLUMN trigger TEXT NOT NULL DEFAULT 'schedule'`);
  if (!haveRun.has('triggered_by')) db.exec(`ALTER TABLE task_runs ADD COLUMN triggered_by TEXT`);
  if (!haveRun.has('temporary')) db.exec(`ALTER TABLE task_runs ADD COLUMN temporary INTEGER NOT NULL DEFAULT 0`);
  if (!haveRun.has('retry_of')) db.exec(`ALTER TABLE task_runs ADD COLUMN retry_of TEXT`);

  // v0.5 → v0.6 (runtime registration, r7 F1): fileManaged flag — default 1
  // (file-managed; backfill = historical behavior), runtime POST /tasks writes 0.
  if (!have.has('file_managed')) db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN file_managed INTEGER NOT NULL DEFAULT 1`);

  // v0.6 → v0.7 (schedule-as-entity, slice 1): schedule_id on runs.
  if (!haveRun.has('schedule_id')) db.exec(`ALTER TABLE task_runs ADD COLUMN schedule_id TEXT`);

  // v0.7 → v0.8 (run-deadline contract, 2026-08-20): timeout_ms on tasks —
  // NULL = absent (legacy behavior), -1 = never auto-terminate, >0 = force-fail
  // deadline. Backfill NULL: existing tasks keep legacy semantics.
  if (!have.has('timeout_ms')) db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN timeout_ms INTEGER`);

  // v0.6 → v0.7 one-shot synthesis: legacy task rows with a schedule become
  // schedule rows — id = task name, dedupKey = task name (deterministic, so a
  // re-synthesis is an idempotent upsert and runtime state transfers by name).
  // Runtime state (nextRunAt/lastRunAt/lockedAt/failCount/retryCount/lastRunId)
  // is COPIED, not moved: the engine keeps reading task rows until slice 2, so
  // task rows stay authoritative and behavior is bit-identical to v1. `data`
  // carries what a v1 schedule run actually sent (config.data ?? config.body).
  if (!hadSchedules) {
    const legacy = db
      .prepare(`SELECT * FROM scheduled_tasks WHERE schedule_json IS NOT NULL AND schedule_json != 'null'`)
      .all() as unknown as TaskRow[];
    const synth = db.prepare(`
      INSERT INTO schedules
        (id, task_name, schedule_json, tz, data, external_id, dedup_key, next_run_at, last_run_at, locked_at, fail_count, priority, retry_json, retry_count, last_run_id, paused, disabled, file_managed, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of legacy) {
      const config = json(row.config_json) as Record<string, unknown> | null;
      const data = config?.data ?? config?.body ?? null;
      synth.run(
        row.name,
        row.name,
        row.schedule_json,
        row.tz,
        jsonString(data),
        null,
        row.name,
        row.next_run_at,
        row.last_run_at,
        row.locked_at,
        row.fail_count,
        row.priority,
        row.retry_json,
        row.retry_count,
        row.last_run_id,
        row.paused,
        row.disabled,
        1,
        Date.now(),
        Date.now(),
      );
    }
  }

  const upsertTask = db.prepare(`
    INSERT INTO scheduled_tasks
      (name, runner, schedule_json, tz, config_json, label, description, next_run_at, last_run_at, locked_at, fail_count, priority, retry_json, retry_count, last_run_id, timeout_ms, paused, disabled, file_managed, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      runner        = excluded.runner,
      schedule_json = excluded.schedule_json,
      tz            = excluded.tz,
      config_json   = excluded.config_json,
      label         = excluded.label,
      description   = excluded.description,
      next_run_at   = excluded.next_run_at,
      last_run_at   = excluded.last_run_at,
      locked_at     = excluded.locked_at,
      fail_count    = excluded.fail_count,
      priority      = excluded.priority,
      retry_json    = excluded.retry_json,
      retry_count   = excluded.retry_count,
      last_run_id   = excluded.last_run_id,
      timeout_ms    = excluded.timeout_ms,
      paused        = excluded.paused,
      disabled      = excluded.disabled,
      file_managed  = excluded.file_managed,
      updated_at    = excluded.updated_at
  `);

  const upsertSchedule = db.prepare(`
    INSERT INTO schedules
      (id, task_name, schedule_json, tz, data, external_id, dedup_key, next_run_at, last_run_at, locked_at, fail_count, priority, retry_json, retry_count, last_run_id, paused, disabled, file_managed, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      task_name     = excluded.task_name,
      schedule_json = excluded.schedule_json,
      tz            = excluded.tz,
      data          = excluded.data,
      external_id   = excluded.external_id,
      dedup_key     = excluded.dedup_key,
      next_run_at   = excluded.next_run_at,
      last_run_at   = excluded.last_run_at,
      locked_at     = excluded.locked_at,
      fail_count    = excluded.fail_count,
      priority      = excluded.priority,
      retry_json    = excluded.retry_json,
      retry_count   = excluded.retry_count,
      last_run_id   = excluded.last_run_id,
      paused        = excluded.paused,
      disabled      = excluded.disabled,
      file_managed  = excluded.file_managed,
      updated_at    = excluded.updated_at
  `);

  const getSchedule = db.prepare('SELECT * FROM schedules WHERE id = ?');
  const getScheduleByDedup = db.prepare('SELECT * FROM schedules WHERE dedup_key = ?');
  // Due selection with the per-task ceiling (a task's schedules are serialized:
  // nothing is due while any sibling schedule is locked). Effective priority is
  // materialized on the schedule row at sync (entry ?? task default), so the
  // sort needs no JOIN and behaves identically on every adapter.
  const listDueSchedules = db.prepare(`
    SELECT * FROM schedules
    WHERE next_run_at IS NOT NULL AND next_run_at <= ?
      AND locked_at IS NULL AND paused = 0 AND disabled = 0
      AND NOT EXISTS (
        SELECT 1 FROM schedules s2 WHERE s2.task_name = schedules.task_name AND s2.locked_at IS NOT NULL
      )
    ORDER BY priority DESC, next_run_at ASC
  `);
  const claimSchedule = db.prepare(`
    UPDATE schedules SET locked_at = ?, updated_at = ?
    WHERE id = ? AND locked_at IS NULL AND paused = 0 AND disabled = 0
      AND NOT EXISTS (
        SELECT 1 FROM schedules s2 WHERE s2.task_name = schedules.task_name AND s2.locked_at IS NOT NULL
      )
  `);
  const completeSchedule = db.prepare(`
    UPDATE schedules
    SET next_run_at = ?, last_run_at = ?, locked_at = NULL,
        fail_count = fail_count + ?, retry_count = ?, last_run_id = ?, updated_at = ?
    WHERE id = ?
  `);
  const reapScheduleLocks = db.prepare(`
    UPDATE schedules
    SET locked_at = NULL, fail_count = fail_count + 1, updated_at = ?
    WHERE locked_at IS NOT NULL AND locked_at < ?
  `);
  const refreshSchedule = db.prepare(`
    UPDATE schedules SET locked_at = ?, updated_at = ?
    WHERE id = ? AND locked_at IS NOT NULL
  `);
  const clearScheduleLocks = db.prepare(`
    UPDATE schedules SET locked_at = NULL, updated_at = ?
    WHERE locked_at IS NOT NULL
  `);
  const listSchedules = (filter: ScheduleListFilter = {}): ScheduleRow[] => {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.taskName !== undefined) {
      where.push('task_name = ?');
      params.push(filter.taskName);
    }
    const sql =
      `SELECT * FROM schedules ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ` +
      `ORDER BY id LIMIT ? OFFSET ?`;
    params.push(Math.min(filter.limit ?? 100, 1000), filter.offset ?? 0);
    return db.prepare(sql).all(...params) as unknown as ScheduleRow[];
  };
  const deleteSchedule = db.prepare('DELETE FROM schedules WHERE id = ?');

  const getTask = db.prepare('SELECT * FROM scheduled_tasks WHERE name = ?');
  const listTasks = (filter: TaskListFilter = {}): TaskRow[] => {
    const sql = `SELECT * FROM scheduled_tasks ORDER BY name LIMIT ? OFFSET ?`;
    const limit = Math.min(filter.limit ?? 100, 1000);
    const offset = filter.offset ?? 0;
    return db.prepare(sql).all(limit, offset) as unknown as TaskRow[];
  };
  const deleteTask = db.prepare('DELETE FROM scheduled_tasks WHERE name = ?');
  const listDue = db.prepare(`
    SELECT * FROM scheduled_tasks
    WHERE next_run_at IS NOT NULL AND next_run_at <= ?
      AND locked_at IS NULL AND paused = 0 AND disabled = 0
    ORDER BY priority DESC, next_run_at ASC
  `);
  const claim = db.prepare(`
    UPDATE scheduled_tasks SET locked_at = ?, updated_at = ?
    WHERE name = ? AND locked_at IS NULL AND paused = 0 AND disabled = 0
  `);
  const complete = db.prepare(`
    UPDATE scheduled_tasks
    SET next_run_at = ?, last_run_at = ?, locked_at = NULL,
        fail_count = fail_count + ?, retry_count = ?, last_run_id = ?, updated_at = ?
    WHERE name = ?
  `);
  const reap = db.prepare(`
    UPDATE scheduled_tasks
    SET locked_at = NULL, fail_count = fail_count + 1, updated_at = ?
    WHERE locked_at IS NOT NULL AND locked_at < ?
  `);
  const refresh = db.prepare(`
    UPDATE scheduled_tasks SET locked_at = ?, updated_at = ?
    WHERE name = ? AND locked_at IS NOT NULL
  `);
  const clearAllLocks = db.prepare(`
    UPDATE scheduled_tasks SET locked_at = NULL, updated_at = ?
    WHERE locked_at IS NOT NULL
  `);
  const createRun = db.prepare(`
    INSERT INTO task_runs
      (id, task_name, runner, started_at, finished_at, status, data, result, error, progress, log, artifacts, worker_ref, attempt, trigger, triggered_by, schedule_id, temporary, retry_of)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getRun = db.prepare('SELECT * FROM task_runs WHERE id = ?');
  const deleteRun = db.prepare('DELETE FROM task_runs WHERE id = ?');

  const listRuns = (filter: RunFilter = {}): RunRow[] => {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.taskName !== undefined) {
      where.push('task_name = ?');
      params.push(filter.taskName);
    }
    if (filter.status !== undefined) {
      where.push('status = ?');
      params.push(filter.status);
    }
    const sql =
      `SELECT * FROM task_runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ` +
      `ORDER BY started_at DESC LIMIT ? OFFSET ?`;
    params.push(Math.min(filter.limit ?? 100, 1000), filter.offset ?? 0);
    return db.prepare(sql).all(...params) as unknown as RunRow[];
  };
  const updateRun = db.prepare(`
    UPDATE task_runs SET
      task_name = ?, runner = ?, started_at = ?, finished_at = ?, status = ?, data = ?, result = ?, error = ?,
      progress = ?, log = ?, artifacts = ?, worker_ref = ?, attempt = ?, trigger = ?, triggered_by = ?, schedule_id = ?, temporary = ?, retry_of = ?
    WHERE id = ?
  `);

  const now = () => Date.now();

  return {
    async upsertTask(task) {
      upsertTask.run(
        task.name,
        task.runner,
        JSON.stringify(task.schedule),
        task.tz,
        JSON.stringify(task.config),
        task.label,
        task.description,
        epoch(task.nextRunAt),
        epoch(task.lastRunAt),
        epoch(task.lockedAt),
        task.failCount,
        task.priority,
        task.retry === null ? null : JSON.stringify(task.retry),
        task.retryCount,
        task.lastRunId,
        task.timeoutMs ?? null,
        task.paused ? 1 : 0,
        task.disabled ? 1 : 0,
        task.fileManaged === false ? 0 : 1,
        now(),
        now(),
      );
    },

    async completeTask(name, result) {
      complete.run(
        epoch(result.nextRunAt),
        result.lastRunAt.getTime(),
        result.failed ? 1 : 0,
        result.retryCount ?? 0,
        result.lastRunId ?? null,
        now(),
        name,
      );
    },

    async createSchedule(schedule) {
      // dedupKey is the stable handle for imperative upserts: a create whose
      // dedupKey already exists updates that row (id preserved), never a dup.
      if (schedule.dedupKey !== null && schedule.dedupKey !== undefined) {
        const existing = getScheduleByDedup.get(schedule.dedupKey) as ScheduleRow | undefined;
        if (existing && existing.id !== schedule.id) {
          upsertSchedule.run(...scheduleValues({ ...schedule, id: existing.id }));
          return rowToSchedule(getSchedule.get(existing.id) as unknown as ScheduleRow);
        }
      }
      upsertSchedule.run(...scheduleValues(schedule));
      return rowToSchedule(getSchedule.get(schedule.id) as unknown as ScheduleRow);
    },

    async getSchedule(id) {
      const row = getSchedule.get(id) as ScheduleRow | undefined;
      return row ? rowToSchedule(row) : null;
    },

    async updateSchedule(id, patch) {
      const row = getSchedule.get(id) as ScheduleRow | undefined;
      if (!row) return; // idempotent no-op, same as updateRun on an unknown run
      const { id: _id, ...rest } = patch; // id is the identity, never patchable
      upsertSchedule.run(...scheduleValues({ ...rowToSchedule(row), ...rest, id }));
    },

    async deleteSchedule(id) {
      deleteSchedule.run(id);
    },

    async listSchedules(filter: ScheduleListFilter = {}) {
      return listSchedules(filter).map(rowToSchedule);
    },

    async listDueSchedules(nowDate) {
      return (listDueSchedules.all(nowDate.getTime()) as unknown as ScheduleRow[]).map(rowToSchedule);
    },

    async claimSchedule(id, at) {
      return claimSchedule.run(at.getTime(), now(), id).changes === 1;
    },

    async completeSchedule(id, result) {
      completeSchedule.run(
        epoch(result.nextRunAt),
        result.lastRunAt.getTime(),
        result.failed ? 1 : 0,
        result.retryCount ?? 0,
        result.lastRunId ?? null,
        now(),
        id,
      );
    },

    async reapZombieScheduleLocks(olderThan) {
      return Number(reapScheduleLocks.run(now(), olderThan.getTime()).changes);
    },

    async refreshScheduleLock(id, at) {
      refreshSchedule.run(at.getTime(), now(), id);
    },

    async clearScheduleLocks() {
      return Number(clearScheduleLocks.run(now()).changes);
    },

    async getTask(name) {
      const row = getTask.get(name) as TaskRow | undefined;
      return row ? rowToTask(row) : null;
    },

    async listTasks(filter: TaskListFilter = {}) {
      return listTasks(filter).map(rowToTask);
    },

    async deleteTask(name) {
      deleteTask.run(name);
    },

    async listDueTasks(nowDate) {
      return (listDue.all(nowDate.getTime()) as unknown as TaskRow[]).map(rowToTask);
    },

    async claimTask(name, at) {
      return claim.run(at.getTime(), now(), name).changes === 1;
    },

    async reapZombieLocks(olderThan) {
      return Number(reap.run(now(), olderThan.getTime()).changes);
    },

    async refreshLock(name, at) {
      refresh.run(at.getTime(), now(), name);
    },

    async clearLocks() {
      return Number(clearAllLocks.run(now()).changes);
    },

    async createRun(run) {
      createRun.run(run.id, ...runValues(run));
    },

    async getRun(runId) {
      const row = getRun.get(runId) as RunRow | undefined;
      return row ? rowToRun(row) : null;
    },

    async deleteRun(runId) {
      deleteRun.run(runId);
    },

    async pruneRuns({ olderThan, temporary }) {
      const res = db.prepare(
        `DELETE FROM task_runs
         WHERE finished_at IS NOT NULL AND finished_at < ?
           AND temporary = ? AND status IN ('succeeded', 'failed', 'cancelled')`,
      ).run(olderThan.getTime(), temporary ? 1 : 0);
      return Number(res.changes);
    },

    async listRuns(filter) {
      return listRuns(filter).map(rowToRun);
    },

    async updateRun(runId, patch) {
      const row = getRun.get(runId) as RunRow | undefined;
      if (!row) return; // unknown run — idempotent no-op, same as finishRun
      updateRun.run(...runValues({ ...rowToRun(row), ...patch }), runId);
    },

    async finishRun(runId, finish) {
      const row = getRun.get(runId) as RunRow | undefined;
      if (!row) return;
      const { status, ...rest } = finish;
      updateRun.run(...runValues({ ...rowToRun(row), ...rest, status, finishedAt: new Date() }), runId);
    },
  };
}
