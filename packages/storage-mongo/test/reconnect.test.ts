import { describe, expect, it, afterAll } from 'vitest';
import { MongoClient } from 'mongodb';
import { createMongoStorage } from '../src/index.js';

const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017';

describe('mongo adapter — connection recovery (prod: books 2026-08-24, "connection 6 ... closed" forever)', () => {
  // Own client: this test destroys the topology on purpose — must not touch the shared one.
  const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 2_000 });
  let storage: Awaited<ReturnType<typeof createMongoStorage>>;

  it('recovers from a dead connection: an op after close() reconnects and succeeds', { timeout: 30_000 }, async () => {
    await client.connect();
    const db = client.db('sched-test-reconnect');
    await db.dropDatabase();
    storage = await createMongoStorage(db);

    // warm-up op proves the pool was live
    await storage.upsertTask(minTask('warmup'));
    expect(await storage.getTask('warmup')).not.toBeNull();

    // prod simulation: the pool is dead (mongo container recreated → sockets closed).
    // The driver throws MongoNotConnectedError on the next op.
    await client.close();

    // THE FIX: the adapter must force a fresh topology and retry — this op must succeed.
    await storage.upsertTask(minTask('after-reconnect'));
    const got = await storage.getTask('after-reconnect');
    expect(got?.name).toBe('after-reconnect');
  });

  it('keeps working across subsequent ops after recovery (the daemon tick/poll/sync loops)', { timeout: 30_000 }, async () => {
    await storage.listDueTasks(new Date());
    await storage.upsertTask(minTask('still-alive'));
    expect((await storage.getTask('still-alive'))?.name).toBe('still-alive');
  });

  afterAll(async () => {
    await client.close().catch(() => {});
  });
});

function minTask(name: string) {
  return {
    name,
    runner: 'http',
    schedule: null,
    tz: 'UTC',
    config: {},
    label: null,
    description: null,
    nextRunAt: new Date(),
    lastRunAt: null,
    lockedAt: null,
    failCount: 0,
    priority: 0,
    retry: null,
    retryCount: 0,
    lastRunId: null,
    paused: false,
    disabled: false,
    fileManaged: true,
  };
}
