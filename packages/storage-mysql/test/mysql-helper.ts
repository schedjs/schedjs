import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import { createMysqlStorage } from '../src/index.js';
import type { Storage } from '@schedjs/core';
import { storageContractTests } from '@schedjs/core/storage-contract';

/**
 * Runs the shared storage contract suite against one MySQL-family database
 * (MariaDB or MySQL — same `mysql2` driver, two dialects). Mirrors
 * mongo.test.ts: same suite, different backend, parity pinned by tests.
 *
 * Perf note: MySQL 8's atomic DDL (DROP/CREATE TABLE) is fsync-heavy in
 * docker-on-Windows, so the full migration runs ONCE in beforeAll; per-test
 * cleanup uses DELETE (plain DML). The migration path is explicitly tested in
 * the `migrations` describe below.
 */
export function runMysqlContractSuite(name: string, url: string): void {
  describe(`mysql adapter — ${name}`, () => {
    let pool: mysql.Pool;
    let storage: Storage;

    beforeAll(async () => {
      // Deterministic baseline: start from a dropped database every run. A
      // crashed earlier run must never leave a half-migrated schema that makes
      // the next open fail (version row missing → v1 re-runs → duplicate index).
      const dbName = url.split('/').pop()!;
      const bare = await mysql.createConnection(url.replace(/\/[^/]*$/, '/'));
      await bare.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await bare.query(`CREATE DATABASE \`${dbName}\``);
      await bare.end();
      pool = mysql.createPool(url);
      storage = await createMysqlStorage(pool); // first open: full migration
    }, 120_000);

    beforeEach(async () => {
      await pool.query('DELETE FROM task_runs');
      await pool.query('DELETE FROM scheduled_tasks');
      await pool.query('DELETE FROM schedules');
      storage = await createMysqlStorage(pool); // no-op migrate, fresh storage
    }, 15_000);

    storageContractTests({ describe, it, expect, beforeEach }, name, () => storage);

    describe('migrations', () => {
      it('first open creates both tables, indexes and the version row', async () => {
        await pool.query('DROP TABLE IF EXISTS task_runs');
        await pool.query('DROP TABLE IF EXISTS scheduled_tasks');
        await pool.query('DROP TABLE IF EXISTS schedules');
        await pool.query('DROP TABLE IF EXISTS sched_schema_version');
        await createMysqlStorage(pool);

        const [tables] = await pool.query(
          `SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE()`,
        );
        const names = (tables as Array<{ name: string }>).map((t) => t.name).sort();
        expect(names).toEqual(['sched_schema_version', 'scheduled_tasks', 'schedules', 'task_runs']);

        const [idx] = await pool.query(
          `SELECT INDEX_NAME AS name FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scheduled_tasks'`,
        );
        expect((idx as Array<{ name: string }>).map((i) => i.name)).toContain('idx_due');

        // R4: the started_at index the since/until window rides on
        const [runIdx] = await pool.query(
          `SELECT INDEX_NAME AS name FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'task_runs'`,
        );
        expect((runIdx as Array<{ name: string }>).map((i) => i.name)).toContain('idx_runs_started');

        // exactly one version row — never one INSERT per migration (peer-review fix)
        const [v] = await pool.query(`SELECT COUNT(*) AS c FROM sched_schema_version`);
        expect(Number((v as Array<{ c: string | number }>)[0]!.c)).toBe(1);
      }, 120_000);

      it('re-open is idempotent and keeps the schema version', async () => {
        const [beforeRows] = await pool.query('SELECT version FROM sched_schema_version');
        await createMysqlStorage(pool); // second open on migrated schema
        const [rows] = await pool.query('SELECT version FROM sched_schema_version');
        // self-relative, not a hardcoded latest: the invariant is "re-open does not
        // bump/rewrite the version row", and the next migration must not break it.
        const versionOf = (r: unknown) => Number((r as Array<{ version: number }>)[0]!.version);
        expect(versionOf(rows)).toBe(versionOf(beforeRows));
      });

      it('v3 -> v5 upgrade synthesizes legacy task schedules (F2)', { timeout: 30_000 }, async () => {
        // Simulate a pre-entity DB exactly as storage-* 0.2.x leaves it: pin the
        // schema version to 3, drop the schedules table, insert one legacy task
        // row carrying a schedule + config.data (the admin's F2 repro shape).
        await pool.query('DROP TABLE IF EXISTS schedules');
        await pool.query('UPDATE sched_schema_version SET version = 3');
        await pool.query(
          `INSERT INTO scheduled_tasks
             (name, runner, schedule_json, tz, config_json, label, description, next_run_at, last_run_at, locked_at, fail_count, priority, retry_json, retry_count, last_run_id, paused, disabled, file_managed, created_at, updated_at)
           VALUES (?, 'http', ?, 'UTC', ?, NULL, NULL, ?, NULL, NULL, 0, 5, ?, 0, NULL, 0, 0, 1, ?, ?)`,
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
        await createMysqlStorage(pool); // v4 recreates schedules, v5 synthesizes
        const [rows] = await pool.query('SELECT * FROM schedules');
        const scheds = rows as Array<Record<string, unknown>>;
        expect(scheds).toHaveLength(1);
        expect(scheds[0]!.id).toBe('seller-sync');
        expect(scheds[0]!.task_name).toBe('seller-sync');
        expect(scheds[0]!.dedup_key).toBe('seller-sync');
        expect(scheds[0]!.data).toBe('{"idSeller":2}');
        expect(Number(scheds[0]!.next_run_at)).toBe(1_700_000_000_000);
        expect(scheds[0]!.priority).toBe(5);
        expect(scheds[0]!.retry_json).toBe(JSON.stringify({ maxAttempts: 2, backoffMs: 1000 }));
        expect(scheds[0]!.file_managed).toBe(1);
      });
    });

    afterAll(async () => {
      await pool.end();
    });
  });
}
