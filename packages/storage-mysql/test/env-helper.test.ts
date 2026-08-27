import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import { createStorage, dbNameFromUrl } from '../src/index.js';

const MYSQL_URL = process.env.MYSQL_URL ?? 'mysql://root:test@127.0.0.1:3308/sched_env_test';

describe('storage-mysql createStorage(env) — the CLI-ready BYO surface', () => {
  beforeAll(async () => {
    // deterministic baseline: the adapter self-migrates, but the database must
    // exist (drop + recreate so a half-migrated schema never poisons the test)
    const dbName = MYSQL_URL.split('/').pop()!;
    const bare = await mysql.createConnection(MYSQL_URL.replace(/\/[^/]*$/, '/'));
    await bare.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await bare.query(`CREATE DATABASE \`${dbName}\``);
    await bare.end();
  }, 120_000);

  afterAll(async () => {
    const dbName = MYSQL_URL.split('/').pop()!;
    const bare = await mysql.createConnection(MYSQL_URL.replace(/\/[^/]*$/, '/'));
    await bare.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await bare.end();
  });

  it('resolves the db name from the URI path', () => {
    expect(dbNameFromUrl('mysql://user:pass@host:3306/mydb')).toBe('mydb');
    expect(dbNameFromUrl('mysql://user:pass@host:3306')).toBe('default');
  });

  it('creates a working storage from MYSQL_URL', async () => {
    const storage = await createStorage({ MYSQL_URL });    const task = {
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
  }, 120_000);

  it('throws a clear error when MYSQL_URL is absent', async () => {
    await expect(createStorage({})).rejects.toThrow(/MYSQL_URL/);
  });
});
