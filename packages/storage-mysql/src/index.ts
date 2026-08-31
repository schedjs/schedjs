import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { createPool } from 'mysql2/promise';
import type {
  ArtifactRef,
  CompleteResult,
  RetryPolicy,
  RunFilter,
  RunFinish,
  RunRecord,
  RunStatus,
  Schedule,
  ScheduleListFilter,
  ScheduleRecord,
  Storage,
  TaskListFilter,
  TaskRecord,
  RunUpdate,
} from '@schedjs/core';

/** DB name from a mysql URI path (`mysql://u:p@host:3306/mydb` → `mydb`). */
export function dbNameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    return path || 'default';
  } catch {
    return 'default';
  }
}

/**
 * CLI-ready surface — the daemon's `--storage mysql` path and the BYO parity
 * contract (same `createStorage(env)` as any custom module). Reads `MYSQL_URL`,
 * creates the mysql2 pool, returns the adapter. The daemon never imports the
 * mysql driver — it only calls this function.
 */
export async function createStorage(env: NodeJS.ProcessEnv = process.env): Promise<Storage> {
  const url = env.MYSQL_URL;
  if (!url) throw new Error('MYSQL_URL is not set — export MYSQL_URL=<connstring>');
  return createMysqlStorage(createPool(url));
}

interface TaskRow {
  name: string;
  runner: string;
  schedule_json: string;
  tz: string;
  config_json: string;
  input_schema: string | null;
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
    inputSchema: row.input_schema === null ? null : (json(row.input_schema) as unknown),
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
  ];
}

/**
 * Versioned schema migrations, applied on open (idempotent). Mirrors the
 * SQLite adapter's "migrate on open" story: a deployed daemon brings its
 * MySQL/MariaDB schema up to the version this build knows, no external
 * migration tooling required. The list ships inside the adapter, so the
 * mechanism travels with the distribution (npm package / docker image).
 *
 * Concurrency note: migrations are NOT advisory-lock guarded (sqlite has the
 * same single-writer assumption). If a future HA story starts two daemons
 * against the same MySQL database at the same moment, add
 * `SELECT GET_LOCK('sched_migrate', 10)` on a dedicated connection first.
 */
/**
 * One migration step. Plain strings are executed verbatim; guarded steps
 * (`ADD COLUMN` ALTERs) run only when the column is missing — so a migration
 * that crashed halfway (some ALTERs applied, version row not bumped) re-runs
 * cleanly instead of failing with "duplicate column". MySQL has no
 * `ADD COLUMN IF NOT EXISTS` (MariaDB-only), hence the INFORMATION_SCHEMA guard.
 */
type MigrationStep = string | { sql: string; guard: { table: string; column: string } } | ((pool: Pool) => Promise<void>);

const MIGRATIONS: Array<{ version: number; up: MigrationStep[] }> = [
  {
    version: 1,
    up: [
      `CREATE TABLE IF NOT EXISTS scheduled_tasks (
        name          VARCHAR(255) PRIMARY KEY,
        runner        VARCHAR(64)  NOT NULL DEFAULT 'http',
        schedule_json TEXT         NOT NULL,
        tz            VARCHAR(64)  NOT NULL DEFAULT 'UTC',
        config_json   TEXT         NOT NULL,
        input_schema  TEXT,
        label         VARCHAR(255),
        description   TEXT,
        next_run_at   BIGINT,
        last_run_at   BIGINT,
        locked_at     BIGINT,
        fail_count    INT          NOT NULL DEFAULT 0,
        priority      INT          NOT NULL DEFAULT 0,
        retry_json    TEXT,
        retry_count   INT          NOT NULL DEFAULT 0,
        timeout_ms    BIGINT,
        paused        TINYINT(1)   NOT NULL DEFAULT 0,
        disabled      TINYINT(1)   NOT NULL DEFAULT 0,
        created_at    BIGINT       NOT NULL,
        updated_at    BIGINT       NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS task_runs (
        id          VARCHAR(64) PRIMARY KEY,
        task_name   VARCHAR(255) NOT NULL,
        runner      VARCHAR(64)  NOT NULL DEFAULT 'http',
        started_at  BIGINT       NOT NULL,
        finished_at BIGINT,
        status      VARCHAR(32)  NOT NULL,
        data        TEXT,
        result      TEXT,
        error       TEXT,
        progress    INT,
        log         TEXT,
        artifacts   TEXT,
        worker_ref  TEXT,
        attempt     INT NOT NULL DEFAULT 1
      )`,
      `CREATE INDEX idx_due ON scheduled_tasks (next_run_at)`,
      `CREATE INDEX idx_runs_task ON task_runs (task_name, started_at)`,
    ],
  },
  {
    // v2 — run metadata parity: trigger/triggeredBy/temporary/retryOf on runs,
    // lastRunId on tasks. Backfill defaults (decision 9): trigger='schedule',
    // temporary=false, retryOf/triggeredBy NULL.
    version: 2,
    up: [
      { sql: `ALTER TABLE scheduled_tasks ADD COLUMN last_run_id VARCHAR(64)`, guard: { table: 'scheduled_tasks', column: 'last_run_id' } },
      { sql: `ALTER TABLE task_runs ADD COLUMN \`trigger\` VARCHAR(16) NOT NULL DEFAULT 'schedule'`, guard: { table: 'task_runs', column: 'trigger' } },
      { sql: `ALTER TABLE task_runs ADD COLUMN triggered_by VARCHAR(255)`, guard: { table: 'task_runs', column: 'triggered_by' } },
      { sql: `ALTER TABLE task_runs ADD COLUMN temporary TINYINT(1) NOT NULL DEFAULT 0`, guard: { table: 'task_runs', column: 'temporary' } },
      { sql: `ALTER TABLE task_runs ADD COLUMN retry_of VARCHAR(64)`, guard: { table: 'task_runs', column: 'retry_of' } },
    ],
  },
  {
    // v3 — runtime registration (r7 F1): fileManaged flag on tasks, default 1
    // (file-managed; backfill = historical behavior), runtime POST /tasks writes 0.
    version: 3,
    up: [{ sql: `ALTER TABLE scheduled_tasks ADD COLUMN file_managed TINYINT(1) NOT NULL DEFAULT 1`, guard: { table: 'scheduled_tasks', column: 'file_managed' } }],
  },
  {
    // v4 — schedule-as-entity (slice 1): schedules as first-class rows
    // (id PK, dedup_key UNIQUE — the idempotent upsert handle) and schedule_id
    // on runs (audit: which schedule fired). Fresh tables are created by the
    // guarded steps; an existing DB self-migrates on open, same as v1–v3.
    version: 4,
    up: [
      `CREATE TABLE IF NOT EXISTS schedules (
        id            VARCHAR(255) PRIMARY KEY,
        task_name     VARCHAR(255) NOT NULL,
        schedule_json TEXT         NOT NULL,
        tz            VARCHAR(64)  NOT NULL DEFAULT 'UTC',
        data          TEXT,
        external_id   VARCHAR(255),
        dedup_key     VARCHAR(255) UNIQUE,
        next_run_at   BIGINT,
        last_run_at   BIGINT,
        locked_at     BIGINT,
        fail_count    INT          NOT NULL DEFAULT 0,
        priority      INT          NOT NULL DEFAULT 0,
        retry_json    TEXT,
        retry_count   INT          NOT NULL DEFAULT 0,
        last_run_id   VARCHAR(64),
        paused        TINYINT(1)   NOT NULL DEFAULT 0,
        disabled      TINYINT(1)   NOT NULL DEFAULT 0,
        file_managed  TINYINT(1)   NOT NULL DEFAULT 1,
        created_at    BIGINT       NOT NULL,
        updated_at    BIGINT       NOT NULL
      )`,
      `CREATE INDEX idx_schedules_task ON schedules (task_name)`,
      { sql: `ALTER TABLE task_runs ADD COLUMN schedule_id VARCHAR(64)`, guard: { table: 'task_runs', column: 'schedule_id' } },
    ],
  },
  {
    // v5 — F&F r8 F2: synthesize legacy task schedules into the schedules
    // table. v4 created the table but never copied `scheduled_tasks` rows, so
    // an upgraded DB silently stopped firing (the engine ticks only schedule
    // rows). Mirrors the sqlite adapter's one-shot synthesis: id = dedupKey =
    // task name, runtime state copied, data from config.data ?? config.body.
    // INSERT IGNORE (id/dedup_key UNIQUE) keeps re-runs idempotent.
    version: 5,
    up: [
      async (pool) => {
        const [legacy] = await pool.query(
          `SELECT * FROM scheduled_tasks WHERE schedule_json IS NOT NULL AND schedule_json != 'null'`,
        );
        for (const row of legacy as Array<Record<string, unknown>>) {
          const config = json(row.config_json as string | null) as Record<string, unknown> | null;
          const data = config?.data ?? config?.body ?? null;
          await pool.query(
            `INSERT IGNORE INTO schedules
              (id, task_name, schedule_json, tz, data, external_id, dedup_key, next_run_at, last_run_at, locked_at, fail_count, priority, retry_json, retry_count, last_run_id, paused, disabled, file_managed, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
            [
              row.name,
              row.name,
              row.schedule_json,
              row.tz,
              jsonString(data),
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
              Date.now(),
              Date.now(),
            ],
          );
        }
      },
    ],
  },
  {
    // v6 — run-deadline contract (2026-08-20): timeout_ms on tasks. NULL =
    // absent (legacy), -1 = never auto-terminate, >0 = force-fail deadline.
    version: 6,
    up: [{ sql: `ALTER TABLE scheduled_tasks ADD COLUMN timeout_ms BIGINT`, guard: { table: 'scheduled_tasks', column: 'timeout_ms' } }],
  },
  {
    // v7 — inputSchema (task:1658): input_schema on tasks. NULL = no schema.
    version: 7,
    up: [{ sql: `ALTER TABLE scheduled_tasks ADD COLUMN input_schema TEXT`, guard: { table: 'scheduled_tasks', column: 'input_schema' } }],
  },
];

async function migrate(pool: Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS sched_schema_version (version INT NOT NULL PRIMARY KEY)`);
  const rows = (await pool.query(`SELECT version FROM sched_schema_version LIMIT 1`))[0] as RowDataPacket[];
  const current = rows.length ? Number(rows[0]!.version) : 0;
  let version = current;
  for (const m of MIGRATIONS) {
    if (m.version <= version) continue;
    for (const step of m.up) {
      if (typeof step === 'function') {
        await step(pool);
        continue;
      }
      if (typeof step === 'string') {
        await pool.query(step);
      } else {
        const rows = (await pool.query(
          `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
          [step.guard.table, step.guard.column],
        ))[0] as RowDataPacket[];
        if (Number((rows[0] as { c: number | string }).c) === 0) await pool.query(step.sql);
      }
    }
    version = m.version; // track within the loop — a single INSERT below, never one per migration
  }
  if (version > current) {
    if (current === 0) {
      await pool.query(`INSERT INTO sched_schema_version (version) VALUES (?)`, [version]);
    } else {
      await pool.query(`UPDATE sched_schema_version SET version = ?`, [version]);
    }
  }
}

/**
 * MySQL / MariaDB storage adapter over the sched {@link Storage} seam, on the
 * `mysql2` driver — one driver covers both dialects (MariaDB 11 + MySQL 8).
 * Same contract as SQLite / Mongo: `storage-contract.ts` runs unchanged
 * against all of them, so adapter parity is test-pinned, not assumed.
 *
 * Timestamps are epoch milliseconds (BIGINT). Claim atomicity is a conditional
 * UPDATE whose affected-rows count must be exactly 1. JSON payloads
 * (config/data/result/artifacts) are stored as TEXT — dialect-agnostic, same
 * as SQLite.
 *
 * Migrations are applied on open from the versioned list above — the daemon
 * self-migrates an existing database (e.g. books' MariaDB) on first start.
 */
export async function createMysqlStorage(pool: Pool): Promise<Storage> {
  await migrate(pool);

  const now = () => Date.now();

  async function loadRun(runId: string): Promise<RunRecord | null> {
    const rows = (await pool.query(`SELECT * FROM task_runs WHERE id = ?`, [runId]))[0] as RowDataPacket[];
    const row = rows[0] as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  async function loadSchedule(id: string): Promise<ScheduleRecord | null> {
    const rows = (await pool.query(`SELECT * FROM schedules WHERE id = ?`, [id]))[0] as RowDataPacket[];
    const row = rows[0] as ScheduleRow | undefined;
    return row ? rowToSchedule(row) : null;
  }

  async function upsertScheduleRow(s: ScheduleRecord): Promise<void> {
    await pool.query(
      `INSERT INTO schedules
        (id, task_name, schedule_json, tz, data, external_id, dedup_key, next_run_at, last_run_at, locked_at, fail_count, priority, retry_json, retry_count, last_run_id, paused, disabled, file_managed, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        task_name     = VALUES(task_name),
        schedule_json = VALUES(schedule_json),
        tz            = VALUES(tz),
        data          = VALUES(data),
        external_id   = VALUES(external_id),
        dedup_key     = VALUES(dedup_key),
        next_run_at   = VALUES(next_run_at),
        last_run_at   = VALUES(last_run_at),
        locked_at     = VALUES(locked_at),
        fail_count    = VALUES(fail_count),
        priority      = VALUES(priority),
        retry_json    = VALUES(retry_json),
        retry_count   = VALUES(retry_count),
        last_run_id   = VALUES(last_run_id),
        paused        = VALUES(paused),
        disabled      = VALUES(disabled),
        file_managed  = VALUES(file_managed),
        updated_at    = VALUES(updated_at)`,
      [...scheduleValues(s), Date.now(), Date.now()],
    );
  }

  async function updateRunRow(runId: string, merged: RunRecord): Promise<void> {
    await pool.query(
      `UPDATE task_runs SET
        task_name = ?, runner = ?, started_at = ?, finished_at = ?, status = ?, data = ?, result = ?, error = ?,
        progress = ?, log = ?, artifacts = ?, worker_ref = ?, attempt = ?, \`trigger\` = ?, triggered_by = ?, schedule_id = ?, temporary = ?, retry_of = ?
      WHERE id = ?`,
      [...runValues(merged), runId],
    );
  }

  return {
    // --- tasks ---
    async upsertTask(task) {
      await pool.query(
        `INSERT INTO scheduled_tasks
          (name, runner, schedule_json, tz, config_json, input_schema, label, description, next_run_at, last_run_at, locked_at, fail_count, priority, retry_json, retry_count, last_run_id, timeout_ms, paused, disabled, file_managed, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          runner        = VALUES(runner),
          schedule_json = VALUES(schedule_json),
          tz            = VALUES(tz),
          config_json   = VALUES(config_json),
          input_schema  = VALUES(input_schema),
          label         = VALUES(label),
          description   = VALUES(description),
          next_run_at   = VALUES(next_run_at),
          last_run_at   = VALUES(last_run_at),
          locked_at     = VALUES(locked_at),
          fail_count    = VALUES(fail_count),
          priority      = VALUES(priority),
          retry_json    = VALUES(retry_json),
          retry_count   = VALUES(retry_count),
          last_run_id   = VALUES(last_run_id),
          timeout_ms    = VALUES(timeout_ms),
          paused        = VALUES(paused),
          disabled      = VALUES(disabled),
          file_managed  = VALUES(file_managed),
          updated_at    = VALUES(updated_at)`,
        [
          task.name,
          task.runner,
          JSON.stringify(task.schedule),
          task.tz,
          JSON.stringify(task.config),
          jsonString(task.inputSchema),
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
        ],
      );
    },

    async getTask(name) {
      const rows = (await pool.query(`SELECT * FROM scheduled_tasks WHERE name = ?`, [name]))[0] as RowDataPacket[];
      const row = rows[0] as TaskRow | undefined;
      return row ? rowToTask(row) : null;
    },

    async listTasks(filter: TaskListFilter = {}) {
      const rows = (await pool.query(`SELECT * FROM scheduled_tasks ORDER BY name LIMIT ? OFFSET ?`, [
        Math.min(filter.limit ?? 100, 1000),
        filter.offset ?? 0,
      ]))[0] as RowDataPacket[];
      return (rows as unknown as TaskRow[]).map(rowToTask);
    },

    async deleteTask(name) {
      await pool.query(`DELETE FROM scheduled_tasks WHERE name = ?`, [name]);
    },

    // --- schedules ---
    async createSchedule(schedule) {
      // dedupKey is the stable handle for imperative upserts: a create whose
      // dedupKey already exists updates that row (id preserved), never a dup.
      if (schedule.dedupKey !== null && schedule.dedupKey !== undefined) {
        const rows = (await pool.query(`SELECT * FROM schedules WHERE dedup_key = ?`, [schedule.dedupKey]))[0] as RowDataPacket[];
        const existing = rows[0] as ScheduleRow | undefined;
        if (existing && existing.id !== schedule.id) {
          await upsertScheduleRow({ ...schedule, id: existing.id });
          return (await loadSchedule(existing.id))!;
        }
      }
      await upsertScheduleRow(schedule);
      return (await loadSchedule(schedule.id))!;
    },

    async getSchedule(id) {
      return loadSchedule(id);
    },

    async updateSchedule(id, patch) {
      const row = await loadSchedule(id);
      if (!row) return; // idempotent no-op
      const { id: _id, ...rest } = patch; // id is the identity, never patchable
      await upsertScheduleRow({ ...row, ...rest, id });
    },

    async deleteSchedule(id) {
      await pool.query(`DELETE FROM schedules WHERE id = ?`, [id]);
    },

    async listSchedules(filter: ScheduleListFilter = {}) {
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
      const rows = (await pool.query(sql, params))[0] as RowDataPacket[];
      return (rows as unknown as ScheduleRow[]).map(rowToSchedule);
    },

    // --- schedule tick loop ---
    async listDueSchedules(nowDate) {
      const rows = (await pool.query(
        `SELECT * FROM schedules
         WHERE next_run_at IS NOT NULL AND next_run_at <= ?
           AND locked_at IS NULL AND paused = 0 AND disabled = 0
           AND NOT EXISTS (
             SELECT 1 FROM schedules s2 WHERE s2.task_name = schedules.task_name AND s2.locked_at IS NOT NULL
           )
         ORDER BY priority DESC, next_run_at ASC`,
        [nowDate.getTime()],
      ))[0] as RowDataPacket[];
      return (rows as unknown as ScheduleRow[]).map(rowToSchedule);
    },

    async claimSchedule(id, at) {
      const res = (await pool.query(
        `UPDATE schedules SET locked_at = ?, updated_at = ?
         WHERE id = ? AND locked_at IS NULL AND paused = 0 AND disabled = 0
           AND NOT EXISTS (
             SELECT 1 FROM (SELECT task_name, locked_at FROM schedules) s2
             WHERE s2.task_name = schedules.task_name AND s2.locked_at IS NOT NULL
           )`,
        [at.getTime(), now(), id],
      ))[0] as ResultSetHeader;
      return res.affectedRows === 1;
    },

    async completeSchedule(id, result) {
      await pool.query(
        `UPDATE schedules
         SET next_run_at = ?, last_run_at = ?, locked_at = NULL,
             fail_count = fail_count + ?, retry_count = ?, last_run_id = ?, updated_at = ?
         WHERE id = ?`,
        [epoch(result.nextRunAt), result.lastRunAt.getTime(), result.failed ? 1 : 0, result.retryCount ?? 0, result.lastRunId ?? null, now(), id],
      );
    },

    async reapZombieScheduleLocks(olderThan) {
      const res = (await pool.query(
        `UPDATE schedules
         SET locked_at = NULL, fail_count = fail_count + 1, updated_at = ?
         WHERE locked_at IS NOT NULL AND locked_at < ?`,
        [now(), olderThan.getTime()],
      ))[0] as ResultSetHeader;
      return res.affectedRows;
    },

    async refreshScheduleLock(id, at) {
      await pool.query(
        `UPDATE schedules SET locked_at = ?, updated_at = ?
         WHERE id = ? AND locked_at IS NOT NULL`,
        [at.getTime(), now(), id],
      );
    },

    async clearScheduleLocks() {
      const res = (await pool.query(
        `UPDATE schedules SET locked_at = NULL, updated_at = ?
         WHERE locked_at IS NOT NULL`,
        [now()],
      ))[0] as ResultSetHeader;
      return res.affectedRows;
    },

    // --- tick loop ---
    async listDueTasks(nowDate) {
      const rows = (await pool.query(
        `SELECT * FROM scheduled_tasks
         WHERE next_run_at IS NOT NULL AND next_run_at <= ?
           AND locked_at IS NULL AND paused = 0 AND disabled = 0
         ORDER BY priority DESC, next_run_at ASC`,
        [nowDate.getTime()],
      ))[0] as RowDataPacket[];
      return (rows as unknown as TaskRow[]).map(rowToTask);
    },

    async claimTask(name, at) {
      const res = (await pool.query(
        `UPDATE scheduled_tasks SET locked_at = ?, updated_at = ?
         WHERE name = ? AND locked_at IS NULL AND paused = 0 AND disabled = 0`,
        [at.getTime(), now(), name],
      ))[0] as ResultSetHeader;
      return res.affectedRows === 1;
    },

    async completeTask(name, result) {
      await pool.query(
        `UPDATE scheduled_tasks
         SET next_run_at = ?, last_run_at = ?, locked_at = NULL,
             fail_count = fail_count + ?, retry_count = ?, last_run_id = ?, updated_at = ?
         WHERE name = ?`,
        [epoch(result.nextRunAt), result.lastRunAt.getTime(), result.failed ? 1 : 0, result.retryCount ?? 0, result.lastRunId ?? null, now(), name],
      );
    },

    async reapZombieLocks(olderThan) {
      const res = (await pool.query(
        `UPDATE scheduled_tasks
         SET locked_at = NULL, fail_count = fail_count + 1, updated_at = ?
         WHERE locked_at IS NOT NULL AND locked_at < ?`,
        [now(), olderThan.getTime()],
      ))[0] as ResultSetHeader;
      return res.affectedRows;
    },

    async refreshLock(name, at) {
      await pool.query(
        `UPDATE scheduled_tasks SET locked_at = ?, updated_at = ?
         WHERE name = ? AND locked_at IS NOT NULL`,
        [at.getTime(), now(), name],
      );
    },

    async clearLocks() {
      const res = (await pool.query(
        `UPDATE scheduled_tasks SET locked_at = NULL, updated_at = ?
         WHERE locked_at IS NOT NULL`,
        [now()],
      ))[0] as ResultSetHeader;
      return res.affectedRows;
    },

    // --- run history ---
    async createRun(run) {
      await pool.query(
        `INSERT INTO task_runs
          (id, task_name, runner, started_at, finished_at, status, data, result, error, progress, log, artifacts, worker_ref, attempt, \`trigger\`, triggered_by, schedule_id, temporary, retry_of)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [run.id, ...runValues(run)],
      );
    },

    async getRun(runId) {
      return loadRun(runId);
    },

    async deleteRun(runId) {
      await pool.query(`DELETE FROM task_runs WHERE id = ?`, [runId]);
    },

    async pruneRuns({ olderThan, temporary }) {
      const res = (await pool.query(
        `DELETE FROM task_runs
         WHERE finished_at IS NOT NULL AND finished_at < ?
           AND temporary = ? AND status IN ('succeeded', 'failed', 'cancelled')`,
        [olderThan.getTime(), temporary ? 1 : 0],
      ))[0] as ResultSetHeader;
      return res.affectedRows;
    },

    async listRuns(filter: RunFilter = {}) {
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
      const rows = (await pool.query(sql, params))[0] as RowDataPacket[];
      return (rows as unknown as RunRow[]).map(rowToRun);
    },

    async updateRun(runId, patch: RunUpdate) {
      const row = await loadRun(runId);
      if (!row) return; // unknown run — idempotent no-op, same as finishRun
      await updateRunRow(runId, { ...row, ...patch });
    },

    async finishRun(runId, finish: RunFinish) {
      const row = await loadRun(runId);
      if (!row) return;
      const { status, ...rest } = finish;
      await updateRunRow(runId, { ...row, ...rest, status, finishedAt: new Date() });
    },
  };
}
