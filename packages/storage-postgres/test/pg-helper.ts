import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createPostgresStorage } from '../src/index.js';
import type { Storage } from '@schedjs/core';
import { storageContractTests } from '@schedjs/core/storage-contract';

/**
 * Runs the shared storage contract suite against one Postgres database.
 * Mirrors mongo.test.ts / mysql-helper.ts: same suite, different backend,
 * parity pinned by tests.
 */
export function runPostgresContractSuite(name: string, url: string): void {
  describe(`postgres adapter — ${name}`, () => {
    let pool: pg.Pool;
    let storage: Storage;

    beforeAll(async () => {
      // Deterministic baseline: drop + recreate so a half-migrated schema from
      // a crashed earlier run can never poison the next open.
      const dbName = url.split('/').pop()!;
      const base = url.replace(/\/[^/]*$/, '/postgres');
      const admin = new pg.Pool({ connectionString: base });
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      } catch {
        // best-effort baseline: a leaked connection from a crashed worker may
        // block the drop — the fresh CREATE below still yields a usable db.
      }
      try {
        await admin.query(`CREATE DATABASE "${dbName}"`);
      } catch (e) {
        if (!(e as { code?: string }).code?.startsWith('42P04')) throw e;
      }
      await admin.end();

      pool = new pg.Pool({ connectionString: url });
      storage = await createPostgresStorage(pool); // first open: full migration
    }, 120_000);

    beforeEach(async () => {
      await pool.query('DELETE FROM task_runs');
      await pool.query('DELETE FROM scheduled_tasks');
      await pool.query('DELETE FROM schedules');
      storage = await createPostgresStorage(pool); // no-op migrate, fresh storage
    }, 15_000);

    storageContractTests({ describe, it, expect, beforeEach }, name, () => storage);

    describe('migrations', () => {
      it('first open creates both tables, indexes and the version row', async () => {
        await pool.query('DROP TABLE IF EXISTS task_runs');
        await pool.query('DROP TABLE IF EXISTS scheduled_tasks');
        await pool.query('DROP TABLE IF EXISTS schedules');
        await pool.query('DROP TABLE IF EXISTS sched_schema_version');
        await createPostgresStorage(pool);

        const tables = await pool.query(
          `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public'`,
        );
        const names = tables.rows.map((r) => r.name as string).sort();
        expect(names).toEqual(['sched_schema_version', 'scheduled_tasks', 'schedules', 'task_runs']);

        const idx = await pool.query(`SELECT indexname AS name FROM pg_indexes WHERE tablename = 'scheduled_tasks'`);
        expect(idx.rows.map((r) => r.name as string)).toContain('idx_due');

        // R4: the started_at index the since/until window rides on
        const runIdx = await pool.query(`SELECT indexname AS name FROM pg_indexes WHERE tablename = 'task_runs'`);
        expect(runIdx.rows.map((r) => r.name as string)).toContain('idx_runs_started');

        // exactly one version row — never one INSERT per migration (peer-review fix)
        const v = await pool.query(`SELECT COUNT(*) AS c FROM sched_schema_version`);
        expect(Number(v.rows[0]!.c)).toBe(1);
      }, 120_000);

      it('re-open is idempotent and keeps the schema version', async () => {
        const before = await pool.query('SELECT version FROM sched_schema_version LIMIT 1');
        await createPostgresStorage(pool); // second open on migrated schema
        const res = await pool.query('SELECT version FROM sched_schema_version LIMIT 1');
        // self-relative, not a hardcoded latest: the invariant is "re-open does not
        // bump/rewrite the version row", and the next migration must not break it.
        expect(Number(res.rows[0]!.version)).toBe(Number(before.rows[0]!.version));
      });

      it('v3 -> v5 upgrade synthesizes legacy task schedules (F2)', async () => {
        // Simulate a pre-entity DB exactly as storage-* 0.2.x leaves it: pin the
        // schema version to 3, drop the schedules table, insert one legacy task
        // row carrying a schedule + config.data (the admin's F2 repro shape).
        await pool.query('DROP TABLE IF EXISTS schedules');
        await pool.query('UPDATE sched_schema_version SET version = 3');
        await pool.query(
          `INSERT INTO scheduled_tasks
             (name, runner, schedule_json, tz, config_json, label, description, next_run_at, last_run_at, locked_at, fail_count, priority, retry_json, retry_count, last_run_id, paused, disabled, file_managed, created_at, updated_at)
           VALUES ($1, 'http', $2, 'UTC', $3, NULL, NULL, $4, NULL, NULL, 0, 5, $5, 0, NULL, false, false, true, $6, $7)`,
          [
            'seller-sync',
            JSON.stringify({ cron: '* * * * *' }),
            JSON.stringify({ url: 'http://worker:3000/x', data: { idSeller: 2 } }),
            1_700_000_000_000,
            JSON.stringify({ maxAttempts: 2, backoffMs: 1000 }),
            Date.now(),
            Date.now(),
          ],
        );
        await createPostgresStorage(pool); // v4 recreates schedules, v5 synthesizes
        const res = await pool.query('SELECT * FROM schedules');
        const scheds = res.rows as Array<Record<string, unknown>>;
        expect(scheds).toHaveLength(1);
        expect(scheds[0]!.id).toBe('seller-sync');
        expect(scheds[0]!.task_name).toBe('seller-sync');
        expect(scheds[0]!.dedup_key).toBe('seller-sync');
        expect(scheds[0]!.data).toBe('{"idSeller":2}');
        expect(Number(scheds[0]!.next_run_at)).toBe(1_700_000_000_000);
        expect(scheds[0]!.priority).toBe(5);
        expect(scheds[0]!.retry_json).toBe(JSON.stringify({ maxAttempts: 2, backoffMs: 1000 }));
        expect(scheds[0]!.file_managed).toBe(true);
      });
    });

    afterAll(async () => {
      await pool.end();
    });
  });
}
