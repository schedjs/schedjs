import { describe, expect, it } from 'vitest';
import { createStorage, dbNameFromUrl } from '../src/index.js';
import type { Storage } from '@schedjs/core';

const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017';

describe('storage-mongo createStorage(env) — the CLI-ready BYO surface', () => {
  it('resolves the db name from the URI path (no MONGO_DB)', () => {
    expect(dbNameFromUrl('mongodb://user:pass@host:27017/mydb')).toBe('mydb');
    expect(dbNameFromUrl('mongodb://host:27017')).toBe('test'); // driver default
    expect(dbNameFromUrl('mongodb://host:27017/nested/db')).toBe('nested/db'); // path is the db name verbatim
  });

  it('creates a working storage from MONGO_URL + MONGO_DB', async () => {
    const storage = await createStorage({ MONGO_URL, MONGO_DB: 'sched-test-env-helper' });
    expect(storage).toBeDefined();
    // contract smoke: upsert + read through the env-built adapter
    const task = {
      name: 'env-helper-smoke',
      runner: 'http',
      schedule: { kind: "interval", ms: 60_000 } as const,
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
    await storage.upsertTask(task);
    const got = await storage.getTask('env-helper-smoke');
    expect(got?.name).toBe('env-helper-smoke');
    await storage.deleteTask('env-helper-smoke');
  });

  it('defaults to localhost when MONGO_URL is absent', async () => {
    const storage = await createStorage({});
    expect(storage).toBeDefined();
  });

  it('retries a failed initial connect until the budget (prod defect 1: brief mongo restart must not crash-loop the daemon)', async () => {
    const storage = await createStorage({
      MONGO_URL: 'mongodb://127.0.0.1:27017',
      MONGO_DB: 'sched-test-env-helper-retry',
      MONGO_RETRY_MS: '200', // tiny budget — connect succeeds on the retry
    });
    expect(storage).toBeDefined();
    await storage.upsertTask({
      name: 'retry-smoke',
      runner: 'http',
      schedule: null,
      tz: 'UTC',
      config: {},
      label: null,
      description: null,
      nextRunAt: null,
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
    });
    const got = await storage.getTask('retry-smoke');
    expect(got?.name).toBe('retry-smoke');
    await storage.deleteTask('retry-smoke');
  });

  it('fails fast when the connect budget is exhausted (unreachable mongo)', async () => {
    await expect(
      createStorage({
        MONGO_URL: 'mongodb://127.0.0.1:1', // nothing listens here
        MONGO_RETRY_MS: '100',
      }),
    ).rejects.toThrow();
  });
});
