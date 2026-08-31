import pg from 'pg';
import type { Pool } from 'pg';
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

/** DB name from a postgres URI path (`postgres://u:p@host:5432/mydb` → `mydb`). */
export function dbNameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    return path || 'default';
  } catch {
    return 'default';
  }
}

/**
 * CLI-ready surface — the daemon's `--storage postgres` path and the BYO parity
 * contract (same `createStorage(env)` as any custom module). Reads `PG_URL`,
 * creates the pg pool, returns the adapter. The daemon never imports the pg
 * driver — it only calls this function.
 */
export async function createStorage(env: NodeJS.ProcessEnv = process.env): Promise<Storage> {
  const url = env.PG_URL;
  if (!url) throw new Error('PG_URL is not set — export PG_URL=<connstring>');
  return createPostgresStorage(new pg.Pool({ connectionString: url }));
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
  next_run_at: string | null;
  last_run_at: string | null;
  locked_at: string | null;
  fail_count: number;
  priority: number;
  retry_json: string | null;
  retry_count: number;
  last_run_id: string | null;
  timeout_ms: number | null;
  paused: boolean;
  disabled: boolean;
  file_managed: boolean;
  created_at: string;
  updated_at: string;
}

interface ScheduleRow {
  id: string;
  task_name: string;
  schedule_json: string;
  tz: string;
  data: string | null;
  external_id: string | null;
  dedup_key: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  locked_at: string | null;
  fail_count: number;
  priority: number;
  retry_json: string | null;
  retry_count: number;
  last_run_id: string | null;
  paused: boolean;
  disabled: boolean;
  file_managed: boolean;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  task_name: string;
  runner: string;
  started_at: string;
  finished_at: string | null;
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
  temporary: boolean;
  retry_of: string | null;
}

const epoch = (d: Date | null): number | null => (d ? d.getTime() : null);
/**
 * Postgres returns BIGINT (int8) columns as strings — convert explicitly
 * instead of mutating the global pg type parser (the host app may rely on
 * string bigints elsewhere).
 */
const num = (v: string | number | null): number | null => (v === null || v === undefined ? null : Number(v));
const date = (n: number | null): Date | null => (n === null ? null : new Date(n));
const json = (s: string | null): unknown => {
  if (s === null || s === undefined) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null; // corrupt row (foreign writer) — degrade, never crash the tick
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
    nextRunAt: date(num(row.next_run_at)),
    lastRunAt: date(num(row.last_run_at)),
    lockedAt: date(num(row.locked_at)),
    failCount: row.fail_count,
    priority: row.priority,
    retry: row.retry_json === null ? null : (json(row.retry_json) as RetryPolicy),
    retryCount: row.retry_count,
    lastRunId: row.last_run_id,
    timeoutMs: row.timeout_ms,
    paused: row.paused,
    disabled: row.disabled,
    fileManaged: row.file_managed,
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
    nextRunAt: date(num(row.next_run_at)),
    lastRunAt: date(num(row.last_run_at)),
    lockedAt: date(num(row.locked_at)),
    failCount: row.fail_count,
    priority: row.priority,
    retry: row.retry_json === null ? null : (json(row.retry_json) as RetryPolicy),
    retryCount: row.retry_count,
    lastRunId: row.last_run_id,
    paused: row.paused,
    disabled: row.disabled,
    fileManaged: row.file_managed,
  };
}

function rowToRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    taskName: row.task_name,
    runner: row.runner,
    startedAt: new Date(Number(row.started_at)),
    finishedAt: date(num(row.finished_at)),
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
    temporary: row.temporary,
    retryOf: row.retry_of,
  };
}

/** Non-id run column values in UPDATE binding order (18). */
function runValues(r: RunRecord): Array<string | number | null | boolean> {
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
    r.temporary,
    r.retryOf,
  ];
}

/** Non-id schedule column values in upsert binding order (19). */
function scheduleValues(s: ScheduleRecord): Array<string | number | null | boolean> {
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
    s.paused,
    s.disabled,
    s.fileManaged === false ? false : true,
  ];
}

/**
 * Versioned schema migrations, applied on open (idempotent) — same mechanism
 * as the MySQL adapter: a versioned list inside the adapter, tracked in
 * `sched_schema_version`, so the npm package / docker image carry the
 * migration story with no external tooling.
 *
 * Concurrency note: migrations are NOT advisory-lock guarded (sqlite has the
 * same single-writer assumption). If a future HA story starts two daemons
 * against the same Postgres at the same moment, wrap `up` in
 * `SELECT pg_advisory_lock(...)` first.
 */
const MIGRATIONS: Array<{ version: number; up: Array<string | ((pool: Pool) => Promise<void>)> }> = [
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
        paused        BOOLEAN      NOT NULL DEFAULT false,
        disabled      BOOLEAN      NOT NULL DEFAULT false,
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
    // temporary=false, retryOf/triggeredBy NULL. IF NOT EXISTS keeps the steps
    // idempotent — a migration that crashed halfway re-runs cleanly.
    version: 2,
    up: [
      `ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS last_run_id VARCHAR(64)`,
      `ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS "trigger" VARCHAR(16) NOT NULL DEFAULT 'schedule'`,
      `ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS triggered_by VARCHAR(255)`,
      `ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS temporary BOOLEAN NOT NULL DEFAULT false`,
      `ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS retry_of VARCHAR(64)`,
    ],
  },
  {
    // v3 — runtime registration (r7 F1): fileManaged flag on tasks, default true
    // (file-managed; backfill = historical behavior), runtime POST /tasks writes false.
    version: 3,
    up: [`ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS file_managed BOOLEAN NOT NULL DEFAULT true`],
  },
  {
    // v4 — schedule-as-entity (slice 1): schedules as first-class rows
    // (id PK, dedup_key UNIQUE — the idempotent upsert handle) and schedule_id
    // on runs (audit: which schedule fired). An existing DB self-migrates on
    // open, same as v1–v3.
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
        paused        BOOLEAN      NOT NULL DEFAULT false,
        disabled      BOOLEAN      NOT NULL DEFAULT false,
        file_managed  BOOLEAN      NOT NULL DEFAULT true,
        created_at    BIGINT       NOT NULL,
        updated_at    BIGINT       NOT NULL
      )`,
      `CREATE INDEX idx_schedules_task ON schedules (task_name)`,
      `ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS schedule_id VARCHAR(64)`,
    ],
  },
  {
    // v5 — F&F r8 F2: synthesize legacy task schedules into the schedules
    // table. v4 created the table but never copied `scheduled_tasks` rows, so
    // an upgraded DB silently stopped firing (the engine ticks only schedule
    // rows). Mirrors the sqlite adapter's one-shot synthesis: id = dedupKey =
    // task name, runtime state copied, data from config.data ?? config.body.
    // ON CONFLICT DO NOTHING (id/dedup_key unique) keeps re-runs idempotent.
    version: 5,
    up: [
      async (pool) => {
        const legacy = await pool.query(
          `SELECT * FROM scheduled_tasks WHERE schedule_json IS NOT NULL AND schedule_json != 'null'`,
        );
        for (const row of legacy.rows as Array<Record<string, unknown>>) {
          const config = json(row.config_json as string | null) as Record<string, unknown> | null;
          const data = config?.data ?? config?.body ?? null;
          await pool.query(
            `INSERT INTO schedules
              (id, task_name, schedule_json, tz, data, external_id, dedup_key, next_run_at, last_run_at, locked_at, fail_count, priority, retry_json, retry_count, last_run_id, paused, disabled, file_managed, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, true, $17, $18)
             ON CONFLICT (id) DO NOTHING`,
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
    up: [`ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS timeout_ms BIGINT`],
  },
  {
    // v7 — inputSchema (task:1658): input_schema on tasks. NULL = no schema.
    version: 7,
    up: [`ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS input_schema TEXT`],
  },
];

async function migrate(pool: Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS sched_schema_version (version INT NOT NULL PRIMARY KEY)`);
  const res = await pool.query(`SELECT version FROM sched_schema_version LIMIT 1`);
  const current = res.rows.length ? Number(res.rows[0]!.version) : 0;
  let version = current;
  for (const m of MIGRATIONS) {
    if (m.version <= version) continue;
    for (const step of m.up) {
      if (typeof step === 'function') {
        await step(pool);
      } else {
        await pool.query(step);
      }
    }
    version = m.version; // track within the loop — a single INSERT below, never one per migration
  }
  if (version > current) {
    if (current === 0) {
      await pool.query(`INSERT INTO sched_schema_version (version) VALUES ($1)`, [version]);
    } else {
      await pool.query(`UPDATE sched_schema_version SET version = $1`, [version]);
    }
  }
}

/**
 * Postgres storage adapter over the sched {@link Storage} seam, on the `pg`
 * driver. Same contract as SQLite / MySQL / Mongo: `storage-contract.ts` runs
 * unchanged against all of them, so adapter parity is test-pinned, not assumed.
 *
 * Timestamps are epoch milliseconds (BIGINT — returned as strings by pg, hence
 * the explicit Number() conversion in the row mappers). Claim atomicity is a
 * conditional UPDATE whose row-count must be exactly 1. JSON payloads
 * (config/data/result/artifacts) are TEXT (parity with sqlite/mysql; JSONB can
 * come later if JSON-path indexes are ever needed).
 */
export async function createPostgresStorage(pool: Pool): Promise<Storage> {
  await migrate(pool);

  const now = () => Date.now();

  async function loadRun(runId: string): Promise<RunRecord | null> {
    const res = await pool.query(`SELECT * FROM task_runs WHERE id = $1`, [runId]);
    const row = res.rows[0] as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  async function loadSchedule(id: string): Promise<ScheduleRecord | null> {
    const res = await pool.query(`SELECT * FROM schedules WHERE id = $1`, [id]);
    const row = res.rows[0] as ScheduleRow | undefined;
    return row ? rowToSchedule(row) : null;
  }

  async function upsertScheduleRow(s: ScheduleRecord): Promise<void> {
    await pool.query(
      `INSERT INTO schedules
        (id, task_name, schedule_json, tz, data, external_id, dedup_key, next_run_at, last_run_at, locked_at, fail_count, priority, retry_json, retry_count, last_run_id, paused, disabled, file_managed, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
      ON CONFLICT (id) DO UPDATE SET
        task_name     = EXCLUDED.task_name,
        schedule_json = EXCLUDED.schedule_json,
        tz            = EXCLUDED.tz,
        data          = EXCLUDED.data,
        external_id   = EXCLUDED.external_id,
        dedup_key     = EXCLUDED.dedup_key,
        next_run_at   = EXCLUDED.next_run_at,
        last_run_at   = EXCLUDED.last_run_at,
        locked_at     = EXCLUDED.locked_at,
        fail_count    = EXCLUDED.fail_count,
        priority      = EXCLUDED.priority,
        retry_json    = EXCLUDED.retry_json,
        retry_count   = EXCLUDED.retry_count,
        last_run_id   = EXCLUDED.last_run_id,
        paused        = EXCLUDED.paused,
        disabled      = EXCLUDED.disabled,
        file_managed  = EXCLUDED.file_managed,
        updated_at    = EXCLUDED.updated_at`,
      [...scheduleValues(s), Date.now(), Date.now()],
    );
  }

  async function updateRunRow(runId: string, merged: RunRecord): Promise<void> {
    await pool.query(
      `UPDATE task_runs SET
        task_name = $1, runner = $2, started_at = $3, finished_at = $4, status = $5, data = $6, result = $7, error = $8,
        progress = $9, log = $10, artifacts = $11, worker_ref = $12, attempt = $13, "trigger" = $14, triggered_by = $15, schedule_id = $16, temporary = $17, retry_of = $18
      WHERE id = $19`,
      [...runValues(merged), runId],
    );
  }

  return {
    // --- tasks ---
    async upsertTask(task) {
      await pool.query(
        `INSERT INTO scheduled_tasks
          (name, runner, schedule_json, tz, config_json, input_schema, label, description, next_run_at, last_run_at, locked_at, fail_count, priority, retry_json, retry_count, last_run_id, timeout_ms, paused, disabled, file_managed, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
        ON CONFLICT (name) DO UPDATE SET
          runner        = EXCLUDED.runner,
          schedule_json = EXCLUDED.schedule_json,
          tz            = EXCLUDED.tz,
          config_json   = EXCLUDED.config_json,
          input_schema  = EXCLUDED.input_schema,
          label         = EXCLUDED.label,
          description   = EXCLUDED.description,
          next_run_at   = EXCLUDED.next_run_at,
          last_run_at   = EXCLUDED.last_run_at,
          locked_at     = EXCLUDED.locked_at,
          fail_count    = EXCLUDED.fail_count,
          priority      = EXCLUDED.priority,
          retry_json    = EXCLUDED.retry_json,
          retry_count   = EXCLUDED.retry_count,
          last_run_id   = EXCLUDED.last_run_id,
          timeout_ms    = EXCLUDED.timeout_ms,
          paused        = EXCLUDED.paused,
          disabled      = EXCLUDED.disabled,
          file_managed  = EXCLUDED.file_managed,
          updated_at    = EXCLUDED.updated_at`,
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
          task.paused,
          task.disabled,
          task.fileManaged === false ? false : true,
          now(),
          now(),
        ],
      );
    },

    async getTask(name) {
      const res = await pool.query(`SELECT * FROM scheduled_tasks WHERE name = $1`, [name]);
      const row = res.rows[0] as TaskRow | undefined;
      return row ? rowToTask(row) : null;
    },

    async listTasks(filter: TaskListFilter = {}) {
      const res = await pool.query(`SELECT * FROM scheduled_tasks ORDER BY name LIMIT $1 OFFSET $2`, [
        Math.min(filter.limit ?? 100, 1000),
        filter.offset ?? 0,
      ]);
      return (res.rows as unknown as TaskRow[]).map(rowToTask);
    },

    async deleteTask(name) {
      await pool.query(`DELETE FROM scheduled_tasks WHERE name = $1`, [name]);
    },

    // --- schedules ---
    async createSchedule(schedule) {
      // dedupKey is the stable handle for imperative upserts: a create whose
      // dedupKey already exists updates that row (id preserved), never a dup.
      if (schedule.dedupKey !== null && schedule.dedupKey !== undefined) {
        const res = await pool.query(`SELECT * FROM schedules WHERE dedup_key = $1`, [schedule.dedupKey]);
        const existing = res.rows[0] as ScheduleRow | undefined;
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
      await pool.query(`DELETE FROM schedules WHERE id = $1`, [id]);
    },

    async listSchedules(filter: ScheduleListFilter = {}) {
      const where: string[] = [];
      const params: Array<string | number> = [];
      if (filter.taskName !== undefined) {
        where.push('task_name = $' + (params.length + 1));
        params.push(filter.taskName);
      }
      const limitIdx = params.length + 1;
      const offsetIdx = params.length + 2;
      const sql =
        `SELECT * FROM schedules ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ` +
        `ORDER BY id LIMIT $${limitIdx} OFFSET $${offsetIdx}`;
      params.push(Math.min(filter.limit ?? 100, 1000), filter.offset ?? 0);
      const res = await pool.query(sql, params);
      return (res.rows as unknown as ScheduleRow[]).map(rowToSchedule);
    },

    // --- schedule tick loop ---
    async listDueSchedules(nowDate) {
      const res = await pool.query(
        `SELECT * FROM schedules
         WHERE next_run_at IS NOT NULL AND next_run_at <= $1
           AND locked_at IS NULL AND paused = false AND disabled = false
           AND NOT EXISTS (
             SELECT 1 FROM schedules s2 WHERE s2.task_name = schedules.task_name AND s2.locked_at IS NOT NULL
           )
         ORDER BY priority DESC, next_run_at ASC`,
        [nowDate.getTime()],
      );
      return (res.rows as unknown as ScheduleRow[]).map(rowToSchedule);
    },

    async claimSchedule(id, at) {
      const res = await pool.query(
        `UPDATE schedules SET locked_at = $1, updated_at = $2
         WHERE id = $3 AND locked_at IS NULL AND paused = false AND disabled = false
           AND NOT EXISTS (
             SELECT 1 FROM schedules s2 WHERE s2.task_name = schedules.task_name AND s2.locked_at IS NOT NULL
           )`,
        [at.getTime(), now(), id],
      );
      return res.rowCount === 1;
    },

    async completeSchedule(id, result) {
      await pool.query(
        `UPDATE schedules
         SET next_run_at = $1, last_run_at = $2, locked_at = NULL,
             fail_count = fail_count + $3, retry_count = $4, last_run_id = $5, updated_at = $6
         WHERE id = $7`,
        [epoch(result.nextRunAt), result.lastRunAt.getTime(), result.failed ? 1 : 0, result.retryCount ?? 0, result.lastRunId ?? null, now(), id],
      );
    },

    async reapZombieScheduleLocks(olderThan) {
      const res = await pool.query(
        `UPDATE schedules
         SET locked_at = NULL, fail_count = fail_count + 1, updated_at = $1
         WHERE locked_at IS NOT NULL AND locked_at < $2`,
        [now(), olderThan.getTime()],
      );
      return res.rowCount ?? 0;
    },

    async refreshScheduleLock(id, at) {
      await pool.query(
        `UPDATE schedules SET locked_at = $1, updated_at = $2
         WHERE id = $3 AND locked_at IS NOT NULL`,
        [at.getTime(), now(), id],
      );
    },

    async clearScheduleLocks() {
      const res = await pool.query(
        `UPDATE schedules SET locked_at = NULL, updated_at = $1
         WHERE locked_at IS NOT NULL`,
        [now()],
      );
      return res.rowCount ?? 0;
    },

    // --- tick loop ---
    async listDueTasks(nowDate) {
      const res = await pool.query(
        `SELECT * FROM scheduled_tasks
         WHERE next_run_at IS NOT NULL AND next_run_at <= $1
           AND locked_at IS NULL AND paused = false AND disabled = false
         ORDER BY priority DESC, next_run_at ASC`,
        [nowDate.getTime()],
      );
      return (res.rows as unknown as TaskRow[]).map(rowToTask);
    },

    async claimTask(name, at) {
      const res = await pool.query(
        `UPDATE scheduled_tasks SET locked_at = $1, updated_at = $2
         WHERE name = $3 AND locked_at IS NULL AND paused = false AND disabled = false`,
        [at.getTime(), now(), name],
      );
      return res.rowCount === 1;
    },

    async completeTask(name, result) {
      await pool.query(
        `UPDATE scheduled_tasks
         SET next_run_at = $1, last_run_at = $2, locked_at = NULL,
             fail_count = fail_count + $3, retry_count = $4, last_run_id = $5, updated_at = $6
         WHERE name = $7`,
        [epoch(result.nextRunAt), result.lastRunAt.getTime(), result.failed ? 1 : 0, result.retryCount ?? 0, result.lastRunId ?? null, now(), name],
      );
    },

    async reapZombieLocks(olderThan) {
      const res = await pool.query(
        `UPDATE scheduled_tasks
         SET locked_at = NULL, fail_count = fail_count + 1, updated_at = $1
         WHERE locked_at IS NOT NULL AND locked_at < $2`,
        [now(), olderThan.getTime()],
      );
      return res.rowCount ?? 0;
    },

    async refreshLock(name, at) {
      await pool.query(
        `UPDATE scheduled_tasks SET locked_at = $1, updated_at = $2
         WHERE name = $3 AND locked_at IS NOT NULL`,
        [at.getTime(), now(), name],
      );
    },

    async clearLocks() {
      const res = await pool.query(
        `UPDATE scheduled_tasks SET locked_at = NULL, updated_at = $1
         WHERE locked_at IS NOT NULL`,
        [now()],
      );
      return res.rowCount ?? 0;
    },

    // --- run history ---
    async createRun(run) {
      await pool.query(
        `INSERT INTO task_runs
          (id, task_name, runner, started_at, finished_at, status, data, result, error, progress, log, artifacts, worker_ref, attempt, "trigger", triggered_by, schedule_id, temporary, retry_of)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [run.id, ...runValues(run)],
      );
    },

    async getRun(runId) {
      return loadRun(runId);
    },

    async deleteRun(runId) {
      await pool.query(`DELETE FROM task_runs WHERE id = $1`, [runId]);
    },

    async pruneRuns({ olderThan, temporary }) {
      const res = await pool.query(
        `DELETE FROM task_runs
         WHERE finished_at IS NOT NULL AND finished_at < $1
           AND temporary = $2 AND status IN ('succeeded', 'failed', 'cancelled')`,
        [olderThan.getTime(), temporary],
      );
      return res.rowCount ?? 0;
    },

    async listRuns(filter: RunFilter = {}) {
      const where: string[] = [];
      const params: Array<string | number> = [];
      if (filter.taskName !== undefined) {
        where.push('task_name = $' + (params.length + 1));
        params.push(filter.taskName);
      }
      if (filter.status !== undefined) {
        where.push('status = $' + (params.length + 1));
        params.push(filter.status);
      }
      const limitIdx = params.length + 1;
      const offsetIdx = params.length + 2;
      const sql =
        `SELECT * FROM task_runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ` +
        `ORDER BY started_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`;
      params.push(Math.min(filter.limit ?? 100, 1000), filter.offset ?? 0);
      const res = await pool.query(sql, params);
      return (res.rows as unknown as RunRow[]).map(rowToRun);
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
