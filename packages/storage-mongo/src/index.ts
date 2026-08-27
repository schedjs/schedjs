import type { Db } from 'mongodb';
import { MongoClient } from 'mongodb';
import type {
  CompleteResult,
  RunFilter,
  RunFinish,
  RunUpdate,
  ScheduleListFilter,
  ScheduleRecord,
  Storage,
  TaskListFilter,
  RunRecord,
  TaskRecord,
} from '@schedjs/core';

export interface MongoStorageOptions {
  /** Collection names. Default: 'sched_tasks' / 'sched_runs' / 'sched_schedules'. */
  collections?: { tasks?: string; runs?: string; schedules?: string };
}

/**
 * Connection-class errors that a fresh topology (close + reconnect) can heal.
 * The mongo driver's SDAM is supposed to recover a dropped pool on its own,
 * but prod proved otherwise (books 2026-08-24: `connection 6 to … closed` for
 * hours after the mongo container was recreated). The adapter must own the
 * reconnect, not trust the driver's internals.
 */
const CONNECTION_ERROR_NAMES = new Set([
  'MongoNetworkError', // socket closed mid-op (the books prod failure mode)
  'MongoNetworkTimeoutError',
  'MongoNotConnectedError', // op on a client whose pool is dead
  'MongoServerSelectionError', // no server reachable (serverSelectionTimeoutMS)
  'MongoTopologyClosedError',
]);

/** True when `err` is a connection-class failure a reconnect can retry past. */
export function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (CONNECTION_ERROR_NAMES.has(err.name)) return true;
  // fallback: message sniffing for driver/OS-level connection failures
  return /connection .*closed|server selection timed out|ECONNREFUSED|ECONNRESET|topology was destroyed/i.test(err.message);
}

/** DB name from a mongo URI path (`mongodb://host:27017/mydb` → `mydb`; driver default `test`). */
export function dbNameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    return path || 'test';
  } catch {
    return 'test';
  }
}

/**
 * CLI-ready surface — the daemon's `--storage mongo` path and the BYO parity
 * contract (same `createStorage(env)` as any custom module). Reads `MONGO_URL`
 * (default `mongodb://127.0.0.1:27017`) and `MONGO_DB` (fallback: the db name
 * from the URI path), creates the client + Db, and returns the adapter. The
 * daemon never imports the mongo driver — it only calls this function.
 *
 * Startup resilience (prod defect 1, books post-cutover 2026-08-22): the initial
 * `client.connect()` is retried with backoff for up to 30s — the *initial*
 * connect happens before the daemon starts, so a brief mongo restart must not
 * exit(1) the daemon into a crash-loop. `MONGO_RETRY_MS` overrides the budget
 * (default 30_000). Runtime drops (mongo recreated while the daemon is up) are
 * healed by {@link withConnectionRetry}, not by this budget — see the wrapper
 * on the returned storage.
 */
export async function createStorage(env: NodeJS.ProcessEnv = process.env): Promise<Storage> {
  const url = env.MONGO_URL ?? 'mongodb://127.0.0.1:27017';
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 2_000 });
  const retryBudgetMs = Number(env.MONGO_RETRY_MS) > 0 ? Number(env.MONGO_RETRY_MS) : 30_000;
  const deadline = Date.now() + retryBudgetMs;
  for (;;) {
    try {
      await client.connect();
      break;
    } catch (err) {
      if (Date.now() >= deadline) throw err; // budget exhausted — fail fast as before
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return createMongoStorage(client.db(env.MONGO_DB ?? dbNameFromUrl(url)));
}

/**
 * Mongo storage adapter over the sched {@link Storage} seam — the "bring your
 * own history" path (vision open-question #2 answered: books keeps run history
 * in mongo). Same contract as the SQLite adapter: `storage-contract.ts` runs
 * unchanged against both, so adapter parity is test-pinned, not assumed.
 *
 * Documents use the TaskRecord/RunRecord field names verbatim (mongo is
 * schemaless — no snake_case or JSON-stringify mapping). Dates are native BSON
 * dates, JSON payloads (config/data/result/artifacts) are native BSON objects.
 * `_id` is projected out everywhere so reads match the seam types exactly.
 *
 * Claim atomicity: `findOneAndUpdate` with a `{ lockedAt: null }` filter —
 * exactly-once claim, same semantics as the SQLite conditional UPDATE.
 */
export async function createMongoStorage(db: Db, options: MongoStorageOptions = {}): Promise<Storage> {
  const client = db.client; // the owning client — the reconnect seam (Db.client is public API)
  const tasks = db.collection<TaskRecord>(options.collections?.tasks ?? 'sched_tasks');
  const runs = db.collection<RunRecord>(options.collections?.runs ?? 'sched_runs');
  const schedules = db.collection<ScheduleRecord>(options.collections?.schedules ?? 'sched_schedules');

  // Retention/query indexes — matches the SQLite adapter's (idx_due, idx_runs_task)
  // plus the admin-API sort indexes (prod defect 2, books post-cutover 2026-08-22):
  // listTasks sorts by {name:1} and listRuns by {startedAt:-1} — without dedicated
  // indexes Mongo falls back to an in-memory sort, which at 55k+ runs exceeds the
  // 32MB sort cap (MongoDB 4.2) and makes /api/tasks + /api/runs error out.
  await tasks.createIndex({ nextRunAt: 1 });
  await tasks.createIndex({ name: 1 });
  await runs.createIndex({ taskName: 1, startedAt: 1 });
  await runs.createIndex({ startedAt: -1 });
  await schedules.createIndex({ taskName: 1 });

  const NO_ID = { projection: { _id: 0 } };

  // F&F r8 F2: legacy DBs (storage-mongo 0.2.x, e.g. books) hold the schedule
  // ON the task document (TaskRecord verbatim — mongo is schemaless, no schema
  // version to pin). The engine ticks only schedule rows, so on first open
  // against such a DB we synthesize one schedule per task-with-schedule —
  // id = dedupKey = task name, runtime state copied, data from config.data ??
  // config.body (mirrors the sqlite adapter). Idempotent guard: only when the
  // schedules collection is empty; replaceOne upsert adds a second safety net.
  if ((await schedules.countDocuments({})) === 0) {
    const legacy = (await tasks.find({ schedule: { $ne: null } }, NO_ID).toArray()) as TaskRecord[];
    for (const task of legacy) {
      const config = task.config ?? {};
      await schedules.replaceOne(
        { id: task.name },
        {
          id: task.name,
          taskName: task.name,
          schedule: task.schedule!,
          tz: task.tz,
          data: (config.data as unknown) ?? (config.body as unknown) ?? null,
          externalId: null,
          dedupKey: task.name,
          nextRunAt: task.nextRunAt,
          lastRunAt: task.lastRunAt,
          lockedAt: task.lockedAt,
          failCount: task.failCount,
          priority: task.priority,
          retry: task.retry,
          retryCount: task.retryCount,
          lastRunId: task.lastRunId,
          paused: task.paused,
          disabled: task.disabled,
          fileManaged: true,
        },
        { upsert: true },
      );
    }
  }

  /** mongo rejects undefined in $set — normalize to explicit null (contract null-parity). */
  const clean = (patch: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) out[k] = v;
    }
    return out;
  };

  return withConnectionRetry(
    {
      // --- tasks ---
      async upsertTask(task) {
      await tasks.replaceOne({ name: task.name }, task, { upsert: true });
    },

    async getTask(name) {
      return tasks.findOne({ name }, NO_ID);
    },

    async listTasks(filter: TaskListFilter = {}) {
      return tasks
        .find({}, NO_ID)
        .sort({ name: 1 })
        .skip(filter.offset ?? 0)
        .limit(Math.min(filter.limit ?? 100, 1000))
        .toArray();
    },

    async deleteTask(name) {
      await tasks.deleteOne({ name });
    },

    // --- schedules ---
    async createSchedule(schedule) {
      // dedupKey is the stable handle for imperative upserts: a create whose
      // dedupKey already exists updates that row (id preserved), never a dup.
      if (schedule.dedupKey !== null && schedule.dedupKey !== undefined) {
        const existing = await schedules.findOne({ dedupKey: schedule.dedupKey }, NO_ID);
        if (existing && existing.id !== schedule.id) {
          await schedules.replaceOne({ id: existing.id }, { ...schedule, id: existing.id }, { upsert: true });
          return (await schedules.findOne({ id: existing.id }, NO_ID)) as ScheduleRecord;
        }
      }
      await schedules.replaceOne({ id: schedule.id }, schedule, { upsert: true });
      return (await schedules.findOne({ id: schedule.id }, NO_ID)) as ScheduleRecord;
    },

    async getSchedule(id) {
      return schedules.findOne({ id }, NO_ID) as Promise<ScheduleRecord | null>;
    },

    async updateSchedule(id, patch) {
      const { id: _id, ...rest } = patch; // id is the identity, never patchable
      await schedules.updateOne({ id }, { $set: clean(rest as Record<string, unknown>) });
    },

    async deleteSchedule(id) {
      await schedules.deleteOne({ id });
    },

    async listSchedules(filter: ScheduleListFilter = {}) {
      const q: Record<string, unknown> = {};
      if (filter.taskName !== undefined) q.taskName = filter.taskName;
      return schedules
        .find(q, NO_ID)
        .sort({ id: 1 })
        .skip(filter.offset ?? 0)
        .limit(Math.min(filter.limit ?? 100, 1000))
        .toArray();
    },

    // --- schedule tick loop ---
    async listDueSchedules(now) {
      // per-task ceiling: a task's schedules are serialized — nothing is due
      // while any sibling schedule of the same task is locked.
      const locked = await schedules.find({ lockedAt: { $ne: null } }, { projection: { taskName: 1 } }).toArray();
      const lockedTasks = locked.map((d) => d.taskName as string);
      const ceiling = lockedTasks.length > 0 ? { taskName: { $nin: lockedTasks } } : {};
      return schedules
        .find({ nextRunAt: { $lte: now }, lockedAt: null, paused: false, disabled: false, ...ceiling }, NO_ID)
        .sort({ priority: -1, nextRunAt: 1 })
        .toArray();
    },

    async claimSchedule(id, now) {
      const claimed = await schedules.findOneAndUpdate(
        // per-task ceiling in the same atomic op: no sibling schedule locked
        {
          id,
          lockedAt: null,
          paused: false,
          disabled: false,
          taskName: { $nin: (await schedules.find({ lockedAt: { $ne: null } }, { projection: { taskName: 1 } }).toArray()).map((d) => d.taskName as string) },
        },
        { $set: { lockedAt: now } },
        { includeResultMetadata: false },
      );
      return claimed !== null;
    },

    async completeSchedule(id, result: CompleteResult) {
      await schedules.updateOne(
        { id },
        {
          $set: {
            nextRunAt: result.nextRunAt,
            lastRunAt: result.lastRunAt,
            lockedAt: null,
            ...(result.retryCount !== undefined ? { retryCount: result.retryCount } : {}),
            ...(result.lastRunId !== undefined ? { lastRunId: result.lastRunId } : {}),
          },
          $inc: { failCount: result.failed ? 1 : 0 },
        },
      );
    },

    async reapZombieScheduleLocks(olderThan) {
      const res = await schedules.updateMany(
        { lockedAt: { $lt: olderThan } },
        { $set: { lockedAt: null }, $inc: { failCount: 1 } },
      );
      return res.modifiedCount;
    },

    async refreshScheduleLock(id, now) {
      await schedules.updateOne({ id, lockedAt: { $ne: null } }, { $set: { lockedAt: now } });
    },

    async clearScheduleLocks() {
      const res = await schedules.updateMany({ lockedAt: { $ne: null } }, { $set: { lockedAt: null } });
      return res.modifiedCount;
    },

    // --- tick loop ---
    async listDueTasks(now) {
      return tasks
        .find({ nextRunAt: { $lte: now }, lockedAt: null, paused: false, disabled: false }, NO_ID)
        .sort({ priority: -1, nextRunAt: 1 })
        .toArray();
    },

    async claimTask(name, now) {
      const claimed = await tasks.findOneAndUpdate(
        { name, lockedAt: null, paused: false, disabled: false },
        { $set: { lockedAt: now } },
        { includeResultMetadata: false },
      );
      return claimed !== null;
    },

    async completeTask(name, result: CompleteResult) {
      await tasks.updateOne(
        { name },
        {
          $set: {
            nextRunAt: result.nextRunAt,
            lastRunAt: result.lastRunAt,
            lockedAt: null,
            ...(result.retryCount !== undefined ? { retryCount: result.retryCount } : {}),
            ...(result.lastRunId !== undefined ? { lastRunId: result.lastRunId } : {}),
          },
          $inc: { failCount: result.failed ? 1 : 0 },
        },
      );
    },

    async reapZombieLocks(olderThan) {
      const res = await tasks.updateMany(
        { lockedAt: { $lt: olderThan } },
        { $set: { lockedAt: null }, $inc: { failCount: 1 } },
      );
      return res.modifiedCount;
    },

    async refreshLock(name, now) {
      await tasks.updateOne({ name, lockedAt: { $ne: null } }, { $set: { lockedAt: now } });
    },

    async clearLocks() {
      const res = await tasks.updateMany({ lockedAt: { $ne: null } }, { $set: { lockedAt: null } });
      return res.modifiedCount;
    },

    // --- run history ---
    async createRun(run) {
      // insertOne mutates its argument (adds _id in-place) — insert a copy so
      // the caller's object stays pristine (the contract suite asserts against
      // its own shared fixtures, which must not gain a stray _id).
      await runs.insertOne({ ...run });
    },

    async getRun(runId) {
      // projection {_id: 0} strips _id at runtime — the cast is honest
      return runs.findOne({ id: runId }, NO_ID) as Promise<RunRecord | null>;
    },

    async updateRun(runId, patch: RunUpdate) {
      await runs.updateOne({ id: runId }, { $set: patch });
    },

    async finishRun(runId, finish: RunFinish) {
      await runs.updateOne(
        { id: runId },
        { $set: { ...finish, finishedAt: new Date() } },
      );
    },

    async deleteRun(runId) {
      await runs.deleteOne({ id: runId });
    },

    async pruneRuns({ olderThan, temporary }) {
      const res = await runs.deleteMany({
        finishedAt: { $lt: olderThan },
        temporary,
        status: { $in: ['succeeded', 'failed', 'cancelled'] },
      });
      return res.deletedCount;
    },

    async listRuns(filter: RunFilter = {}) {
      const q: Record<string, unknown> = {};
      if (filter.taskName !== undefined) q.taskName = filter.taskName;
      if (filter.status !== undefined) q.status = filter.status;
      return runs
        .find(q, NO_ID)
        .sort({ startedAt: -1 })
        .skip(filter.offset ?? 0)
        .limit(Math.min(filter.limit ?? 100, 1000))
        .toArray();
    },
    },
    client,
  );
}

/**
 * Wrap every storage op so a connection-class failure (dead pool, dropped
 * socket, recreated server) forces a fresh topology and retries — the daemon's
 * sync/tick/poll loops must not run against a stale connection for hours
 * (books prod 2026-08-24: `connection 6 to … closed`, tasks not scheduled,
 * no alerts — the driver's SDAM never rebuilt the pool). Non-connection errors
 * propagate unchanged. Retry is bounded (maxRetries) so a genuinely-down mongo
 * still surfaces as an op failure, not an infinite hang.
 */
function withConnectionRetry<T extends object>(
  storage: T,
  client: MongoClient,
  maxRetries = 2,
): T {
  const src = storage as Record<string, unknown>;
  const wrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (typeof value === 'function') {
      const fn = value as (...args: unknown[]) => unknown;
      wrapped[key] = async (...args: unknown[]) => {
        let lastErr: unknown;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            return await fn(...args);
          } catch (err) {
            lastErr = err;
            if (!isConnectionError(err) || attempt >= maxRetries) throw err;
            // close() drops the dead pool (idempotent — safe when already
            // closed); connect() rebuilds the topology and re-resolves DNS
            // (the container-recreate case). Verified on mongodb 6.21: connect
            // after close is supported — it creates a fresh Topology.
            await client.close().catch(() => {});
            await client.connect();
          }
        }
        throw lastErr;
      };
    } else {
      wrapped[key] = value;
    }
  }
  return wrapped as T;
}
