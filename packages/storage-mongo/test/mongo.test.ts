import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { MongoClient } from 'mongodb';
import { createMongoStorage } from '../src/index.js';
import { storageContractTests } from '@schedjs/core/storage-contract';
import type { Storage } from '@schedjs/core';

const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017';

describe('mongo adapter', () => {
  const client = new MongoClient(MONGO_URL);
  const db = client.db('sched-test');
  let storage: Storage;

  beforeEach(async () => {
    // Per-test cleanup via plain deletes, NOT dropDatabase — dropping the whole
    // DB on every test is fsync-heavy on docker-on-Windows (mongo journal) and
    // times the suite out under parallel load. Same pattern as mysql-helper
    // (plain DML instead of atomic DDL).
    await Promise.all([
      db.collection('sched_tasks').deleteMany({}),
      db.collection('sched_runs').deleteMany({}),
      db.collection('sched_schedules').deleteMany({}),
    ]);
    storage = await createMongoStorage(db);
  });

  storageContractTests({ describe, it, expect, beforeEach }, 'mongo', () => storage);

  describe('legacy schedule synthesis (F2)', () => {
    // Legacy books/mongo DBs (storage-mongo 0.2.x) hold the schedule ON the task
    // document (TaskRecord verbatim — mongo is schemaless, no migrations). On
    // first open against such a DB, the adapter must synthesize one schedule
    // row per legacy task-with-schedule, or the engine (which ticks only
    // schedule rows) would silently stop firing them.
    const legacyTask = {
      name: 'seller-sync',
      runner: 'http',
      schedule: { kind: 'cron', cron: '* * * * *' },
      tz: 'UTC',
      config: { url: 'http://worker:3000/x', data: { idSeller: 2 } },
      label: null,
      description: null,
      nextRunAt: new Date(1_700_000_000_000),
      lastRunAt: null,
      lockedAt: null,
      failCount: 0,
      priority: 5,
      retry: { maxAttempts: 2, backoffMs: 1000 },
      retryCount: 0,
      lastRunId: null,
      paused: false,
      disabled: false,
    };

    it('synthesizes schedule rows from legacy tasks with a schedule on first open', { timeout: 30_000 }, async () => {
      const db = client.db('sched-test');
      await db.dropDatabase();
      await db.collection('sched_tasks').insertOne(legacyTask);
      const storage2 = await createMongoStorage(db);
      const scheds = await storage2.listSchedules();
      expect(scheds).toHaveLength(1);
      expect(scheds[0]!.id).toBe('seller-sync');
      expect(scheds[0]!.taskName).toBe('seller-sync');
      expect(scheds[0]!.dedupKey).toBe('seller-sync');
      expect(scheds[0]!.schedule).toEqual({ kind: 'cron', cron: '* * * * *' });
      expect(scheds[0]!.data).toEqual({ idSeller: 2 });
      expect(scheds[0]!.priority).toBe(5);
      expect(scheds[0]!.retry).toEqual({ maxAttempts: 2, backoffMs: 1000 });
      expect(scheds[0]!.nextRunAt?.getTime()).toBe(1_700_000_000_000);
      expect(scheds[0]!.fileManaged).toBe(true);
    });

    it('is idempotent across re-opens and skips DBs that already have schedules', { timeout: 30_000 }, async () => {
      const db = client.db('sched-test');
      await db.dropDatabase();
      await db.collection('sched_tasks').insertOne(legacyTask);
      await createMongoStorage(db);
      await createMongoStorage(db); // second open must not duplicate
      const count = await db.collection('sched_schedules').countDocuments({});
      expect(count).toBe(1);

      // a DB that already has schedule rows (e.g. runtime-created) — no synthesis
      const db2 = client.db('sched-test-2');
      await db2.dropDatabase();
      await db2.collection('sched_tasks').insertOne(legacyTask);
      await db2.collection('sched_schedules').insertOne({ id: 'runtime-1', taskName: 'x' });
      await createMongoStorage(db2);
      const scheds = await db2.collection('sched_schedules').countDocuments({});
      expect(scheds).toBe(1); // untouched — only the runtime row
    });
  });

  describe('sort indexes (prod defect 2: /api/tasks + /api/runs fall over at 55k runs)', () => {
    // books post-cutover 2026-08-22: listTasks sorts by {name:1}, listRuns by
    // {startedAt:-1}. Without dedicated indexes Mongo does an in-memory sort —
    // at 55k+ runs that exceeds the 32MB sort cap (MongoDB 4.2) and the admin
    // endpoints error. The adapter must create the indexes at open, so a fresh
    // deployment never hits the operator-manual-index step again.
    it('creates {name:1} on tasks and {startedAt:-1} on runs at open', { timeout: 30_000 }, async () => {
      const db = client.db('sched-test');
      await db.dropDatabase();
      const storage2 = await createMongoStorage(db);
      void storage2;
      const taskIdx = await db.collection('sched_tasks').indexes();
      const runIdx = await db.collection('sched_runs').indexes();
      const taskNames = taskIdx.map((i) => i.name);
      const runNames = runIdx.map((i) => i.name);
      // the sort indexes must exist (name on tasks, startedAt desc on runs)
      expect(taskNames).toContain('name_1');
      expect(runNames).toContain('startedAt_-1');
      // and they must actually serve the sort: 60k runs list without error
      const runs = db.collection('sched_runs');
      const bulk = runs.initializeUnorderedBulkOp();
      for (let i = 0; i < 60_000; i++) {
        bulk.insert({
          id: `r-${i}`,
          taskName: `t-${i % 10}`,
          runner: 'http',
          startedAt: new Date(1_700_000_000_000 + i),
          finishedAt: null,
          status: 'succeeded',
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
        });
      }
      await bulk.execute();
      const listed = await storage2.listRuns({ limit: 10 });
      expect(listed).toHaveLength(10);
      expect(listed[0]!.startedAt.getTime()).toBeGreaterThan(listed[9]!.startedAt.getTime());
    });
  });

  afterAll(async () => {
    await client.close();
  });
});
