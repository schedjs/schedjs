import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createStorage, dbNameFromUrl } from '../src/index.js';

const PG_URL = process.env.PG_URL ?? 'postgres://postgres:test@127.0.0.1:5433/sched_env_test';

describe('storage-postgres createStorage(env) — the CLI-ready BYO surface', () => {
  beforeAll(async () => {
    const dbName = PG_URL.split('/').pop()!;
    const base = PG_URL.replace(/\/[^/]*$/, '/postgres');
    const admin = new pg.Pool({ connectionString: base });
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    } catch {
      // best-effort baseline (leaked connection may block the drop)
    }
    try {
      await admin.query(`CREATE DATABASE "${dbName}"`);
    } catch (e) {
      if (!(e as { code?: string }).code?.startsWith('42P04')) throw e;
    }
    await admin.end();
  }, 120_000);

  afterAll(async () => {
    const dbName = PG_URL.split('/').pop()!;
    const base = PG_URL.replace(/\/[^/]*$/, '/postgres');
    const admin = new pg.Pool({ connectionString: base });
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    } catch {
      // ignore — cleanup is best-effort
    }
    await admin.end();
  });

  it('resolves the db name from the URI path', () => {
    expect(dbNameFromUrl('postgres://user:pass@host:5432/mydb')).toBe('mydb');
    expect(dbNameFromUrl('postgres://user:pass@host:5432')).toBe('default');
  });

  it('creates a working storage from PG_URL', async () => {
    const storage = await createStorage({ PG_URL });
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
  }, 120_000);

  it('throws a clear error when PG_URL is absent', async () => {
    await expect(createStorage({})).rejects.toThrow(/PG_URL/);
  });
});
