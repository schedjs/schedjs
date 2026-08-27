import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, beforeEach } from 'vitest';
import { createSqliteStorage } from '../src/sqlite.js';
import { storageContractTests, makeTask } from '../src/storage-contract.js';
import type { RunRecord } from '../src/types.js';

function makeRun(id: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    taskName: 'task-a',
    runner: 'http',
    startedAt: new Date('2026-08-16T09:00:00Z'),
    finishedAt: null,
    status: 'running',
    data: null,
    result: null,
    error: null,
    progress: null,
    log: null,
    artifacts: null,
    workerRef: null,
    attempt: 1,
    trigger: 'schedule',
    triggeredBy: null,
    scheduleId: null,
    temporary: false,
    retryOf: null,
    ...overrides,
  };
}

describe('sqlite adapter', () => {
  storageContractTests({ describe, it, expect, beforeEach }, 'sqlite (:memory:)', () =>
    createSqliteStorage(new DatabaseSync(':memory:')),
  );

  it('schema is re-entrant: creating a storage on the same db twice does not fail', () => {
    const db = new DatabaseSync(':memory:');
    createSqliteStorage(db);
    expect(() => createSqliteStorage(db)).not.toThrow();
  });

  it('migrates an existing v0.1 db (no runner/label/description columns)', async () => {
    const db = new DatabaseSync(':memory:');
    // the pre-format-parity schema
    db.exec(`
      CREATE TABLE scheduled_tasks (
        name          TEXT PRIMARY KEY,
        schedule_json TEXT NOT NULL,
        tz            TEXT NOT NULL DEFAULT 'UTC',
        config_json   TEXT NOT NULL DEFAULT '{}',
        next_run_at   INTEGER,
        last_run_at   INTEGER,
        locked_at     INTEGER,
        fail_count    INTEGER NOT NULL DEFAULT 0,
        paused        INTEGER NOT NULL DEFAULT 0,
        disabled      INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );
      CREATE TABLE task_runs (
        id TEXT PRIMARY KEY, task_name TEXT NOT NULL, started_at INTEGER NOT NULL,
        finished_at INTEGER, status TEXT NOT NULL, error TEXT
      );
    `);
    // an old row survives the migration with defaults
    db.prepare(`INSERT INTO scheduled_tasks
      (name, schedule_json, tz, config_json, next_run_at, last_run_at, locked_at, fail_count, paused, disabled, created_at, updated_at)
      VALUES ('legacy', '{"kind":"cron","cron":"0 9 * * *"}', 'UTC', '{}', NULL, NULL, NULL, 0, 0, 0, 0, 0)`).run();
    // an old run row (pre-v2) survives too, with v2 defaults
    db.prepare(`INSERT INTO task_runs
      (id, task_name, started_at, finished_at, status, error)
      VALUES ('legacy-run', 'legacy', 1750000000000, NULL, 'running', NULL)`).run();

    const storage = createSqliteStorage(db);

    const legacy = await storage.getTask('legacy');
    expect(legacy!.runner).toBe('http');
    expect(legacy!.label).toBeNull();

    // old run row reads back as a complete v2 RunRecord
    const legacyRun = await storage.getRun('legacy-run');
    expect(legacyRun!.runner).toBe('http');
    expect(legacyRun!.status).toBe('running');
    expect(legacyRun!.data).toBeNull();
    expect(legacyRun!.result).toBeNull();
    expect(legacyRun!.progress).toBeNull();
    expect(legacyRun!.log).toBeNull();
    expect(legacyRun!.artifacts).toBeNull();
    expect(legacyRun!.workerRef).toBeNull();

    // new fields round-trip on a fresh task
    await storage.upsertTask(makeTask({ name: 'fresh', runner: 'docker', label: 'L', description: 'D' }));
    const fresh = await storage.getTask('fresh');
    expect(fresh!.runner).toBe('docker');
    expect(fresh!.label).toBe('L');
    expect(fresh!.description).toBe('D');
  });

  it('migrates an existing db without the timeout_ms column (legacy tasks read as timeoutMs null)', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE scheduled_tasks (
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
        paused        INTEGER NOT NULL DEFAULT 0,
        disabled      INTEGER NOT NULL DEFAULT 0,
        file_managed  INTEGER NOT NULL DEFAULT 1,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );
      CREATE TABLE task_runs (
        id TEXT PRIMARY KEY, task_name TEXT NOT NULL, started_at INTEGER NOT NULL,
        finished_at INTEGER, status TEXT NOT NULL, error TEXT
      );
    `);
    db.prepare(`INSERT INTO scheduled_tasks
      (name, runner, schedule_json, tz, config_json, label, description, next_run_at, last_run_at, locked_at, fail_count, priority, retry_json, retry_count, last_run_id, paused, disabled, file_managed, created_at, updated_at)
      VALUES ('legacy', 'http', '{"kind":"cron","cron":"0 9 * * *"}', 'UTC', '{}', NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, 0, NULL, 0, 0, 1, 0, 0)`).run();

    const storage = createSqliteStorage(db);

    const legacy = await storage.getTask('legacy');
    expect(legacy!.timeoutMs).toBeNull(); // migrated legacy row → NULL (engine global cap until a re-sync writes the tasks.json default -1)

    // timeoutMs values round-trip: -1 and positive
    await storage.upsertTask(makeTask({ name: 'never', timeoutMs: -1 }));
    await storage.upsertTask(makeTask({ name: 'deadline', timeoutMs: 3_600_000 }));
    expect((await storage.getTask('never'))!.timeoutMs).toBe(-1);
    expect((await storage.getTask('deadline'))!.timeoutMs).toBe(3_600_000);
  });

  it('migrates an existing v0.4 db (no run metadata columns / last_run_id) with backfill defaults', async () => {
    const db = new DatabaseSync(':memory:');
    // the pre-run-metadata-parity schema (v0.4)
    db.exec(`
      CREATE TABLE scheduled_tasks (
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
        paused        INTEGER NOT NULL DEFAULT 0,
        disabled      INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );
      CREATE TABLE task_runs (
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
        attempt     INTEGER NOT NULL DEFAULT 1
      );
    `);
    // a legacy row survives the migration with decision-9 backfill defaults
    db.prepare(`INSERT INTO scheduled_tasks
      (name, schedule_json, tz, config_json, next_run_at, last_run_at, locked_at, fail_count, priority, retry_json, retry_count, paused, disabled, created_at, updated_at)
      VALUES ('legacy', '{"kind":"cron","cron":"0 9 * * *"}', 'UTC', '{}', NULL, NULL, NULL, 0, 0, NULL, 0, 0, 0, 0, 0)`).run();
    db.prepare(`INSERT INTO task_runs
      (id, task_name, runner, started_at, finished_at, status, data, result, error, progress, log, artifacts, worker_ref, attempt)
      VALUES ('legacy-run', 'legacy', 'http', 1750000000000, 1750000060000, 'succeeded', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1)`).run();

    const storage = createSqliteStorage(db);

    const legacyRun = await storage.getRun('legacy-run');
    expect(legacyRun!.trigger).toBe('schedule');
    expect(legacyRun!.triggeredBy).toBeNull();
    expect(legacyRun!.temporary).toBe(false);
    expect(legacyRun!.retryOf).toBeNull();
    expect(legacyRun!.status).toBe('succeeded');

    const legacyTask = await storage.getTask('legacy');
    expect(legacyTask!.lastRunId).toBeNull();

    // new columns round-trip on a fresh run
    await storage.createRun(makeRun('r-new', { trigger: 'manual', triggeredBy: 'me@x.com', temporary: true, retryOf: 'legacy-run' }));
    expect(await storage.getRun('r-new')).toEqual(
      makeRun('r-new', { trigger: 'manual', triggeredBy: 'me@x.com', temporary: true, retryOf: 'legacy-run' }),
    );
  });

  it('v0.6 → v0.7: synthesizes one schedule per legacy task row (id = dedupKey = task name), state copied, one-shot', async () => {
    const db = new DatabaseSync(':memory:');
    // a v0.6 database: tasks carry schedules + runtime state, NO schedules table
    db.exec(`
      CREATE TABLE scheduled_tasks (
        name TEXT PRIMARY KEY, runner TEXT NOT NULL DEFAULT 'http', schedule_json TEXT NOT NULL,
        tz TEXT NOT NULL DEFAULT 'UTC', config_json TEXT NOT NULL DEFAULT '{}', label TEXT, description TEXT,
        next_run_at INTEGER, last_run_at INTEGER, locked_at INTEGER, fail_count INTEGER NOT NULL DEFAULT 0,
        priority INTEGER NOT NULL DEFAULT 0, retry_json TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
        last_run_id TEXT, paused INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0,
        file_managed INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE task_runs (
        id TEXT PRIMARY KEY, task_name TEXT NOT NULL, runner TEXT NOT NULL DEFAULT 'http',
        started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL, data TEXT, result TEXT,
        error TEXT, progress INTEGER, log TEXT, artifacts TEXT, worker_ref TEXT, attempt INTEGER NOT NULL DEFAULT 1,
        trigger TEXT NOT NULL DEFAULT 'schedule', triggered_by TEXT, temporary INTEGER NOT NULL DEFAULT 0, retry_of TEXT
      );
    `);
    const t0 = 1755363600000; // 2026-08-17T09:00:00Z
    const tLast = 1755277200000; // 2026-08-16T09:00:00Z
    const tLocked = 1755360000000;
    // a scheduled task with runtime state + config.data (what v1 runs actually sent)
    db.prepare(`INSERT INTO scheduled_tasks
      (name, runner, schedule_json, tz, config_json, next_run_at, last_run_at, locked_at, fail_count, priority, retry_json, retry_count, last_run_id, paused, disabled, file_managed, created_at, updated_at)
      VALUES ('legacy', 'http', '{"kind":"cron","cron":"0 9 * * *"}', 'UTC', '{"url":"http://w","data":{"idSeller":2}}', ?, ?, ?, 1, 0, NULL, 0, 'r-legacy', 0, 0, 1, 0, 0)`)
      .run(t0, tLast, tLocked);
    // a trigger-only task (no schedule) must NOT get a synthesized schedule
    db.prepare(`INSERT INTO scheduled_tasks
      (name, runner, schedule_json, tz, config_json, next_run_at, created_at, updated_at)
      VALUES ('manual-only', 'http', 'null', 'UTC', '{}', NULL, 0, 0)`).run();

    const storage = createSqliteStorage(db);

    // synthesized schedule: id = task name, dedupKey = task name, state COPIED
    const sched = await storage.getSchedule('legacy');
    expect(sched!.schedule).toEqual({ kind: 'cron', cron: '0 9 * * *' });
    expect(sched!.tz).toBe('UTC');
    expect(sched!.data).toEqual({ idSeller: 2 }); // config.data ?? config.body carried
    expect(sched!.dedupKey).toBe('legacy');
    expect(sched!.nextRunAt).toEqual(new Date(t0));
    expect(sched!.lastRunAt).toEqual(new Date(tLast));
    expect(sched!.lockedAt).toEqual(new Date(tLocked));
    expect(sched!.failCount).toBe(1);
    expect(sched!.lastRunId).toBe('r-legacy');
    expect(sched!.fileManaged).toBe(true);
    // trigger-only task → no schedule row
    expect(await storage.getSchedule('manual-only')).toBeNull();
    expect(await storage.listSchedules()).toHaveLength(1);

    // task rows keep their state — the engine still reads them (bit-identical v1)
    const task = await storage.getTask('legacy');
    expect(task!.nextRunAt).toEqual(new Date(t0));
    expect(task!.lockedAt).toEqual(new Date(tLocked));

    // re-open: synthesis is one-shot (table exists) — no duplicates
    createSqliteStorage(db);
    expect(await storage.listSchedules()).toHaveLength(1);

    // run rows gained schedule_id (backfill null) and new runs round-trip it
    await storage.createRun(makeRun('r-sched', { scheduleId: 'legacy' }));
    expect((await storage.getRun('r-sched'))!.scheduleId).toBe('legacy');
  });
});

describe('sqlite adapter — corrupt JSON (peer-review regression)', () => {
  it('degrades to null fields instead of throwing on a corrupt row (foreign writer)', async () => {
    const db = new DatabaseSync(':memory:');
    const storage = createSqliteStorage(db);
    await storage.upsertTask(makeTask());
    db.prepare(`UPDATE scheduled_tasks SET config_json = '{not json', schedule_json = '[1,2' WHERE name = 'task-a'`).run();

    const t = await storage.getTask('task-a'); // must not throw
    expect(t!.config).toBeNull();
    expect(t!.schedule).toBeNull();
    expect(t!.name).toBe('task-a'); // other fields still readable
  });

  it('does not break listDueTasks on a corrupt task', async () => {
    const db = new DatabaseSync(':memory:');
    const storage = createSqliteStorage(db);
    await storage.upsertTask(makeTask({ name: 'good', nextRunAt: new Date('2026-08-16T09:00:00Z') }));
    await storage.upsertTask(makeTask({ name: 'bad', nextRunAt: new Date('2026-08-16T08:00:00Z') }));
    db.prepare(`UPDATE scheduled_tasks SET schedule_json = 'garbage' WHERE name = 'bad'`).run();

    const due = await storage.listDueTasks(new Date('2026-08-16T10:00:00Z')); // must not throw
    expect(due.map((t) => t.name)).toEqual(['bad', 'good']); // nextRunAt ASC
  });
});
