# Build your own adapter

> Anything that isn't SQLite / MySQL / MariaDB / Postgres / Mongo can still be a storage backend

Anything that isn't SQLite / MySQL / MariaDB / Postgres / Mongo can still be a
storage backend: implement the `Storage` interface, run the contract suite, pass
the adapter to `createEngine` / `createDaemon`. That's the whole integration
test — parity with the shipped adapters is **test-pinned, not assumed**. No ORM
needed: an adapter is a raw driver + the suite (see `@schedjs/storage-mysql` /
`@schedjs/storage-postgres` for the ~400-line reference shape).

For the **binary** (`schedd`) the custom adapter plugs in via
`--storage <npm-package>` or `--storage <./path>` — the module must export the
**same** `createStorage(env)` function the built-in adapters export (see
[Storage overview](/docs/storage)):

```ts
// my-sched-storage/package.json → main: index.js
export async function createStorage(env: NodeJS.ProcessEnv): Promise<Storage> {
  const client = new MyDriver({ url: env.MY_STORAGE_URL }); // your own env vars
  await client.connect();
  return createMyStorage(client); // a full Storage implementation
}
```

```bash
MY_STORAGE_URL=… schedd --tasks tasks.json --storage ./my-sched-storage
```

Specifier disjunction: `./`, `../`, `/` → a filesystem path (relative to the
daemon's cwd); anything else → an npm package resolved from the image. Fail-fast
at startup: module missing → `add it to your image (RUN yarn add …)`; module
exporting something that isn't `createStorage(env)` → contract error pointing at
this page.

**The contract is interface + suite + published .d.ts** — the prose below
describes semantics, but the precise method signatures and record shapes
(`CompleteResult`, `RunUpdate`, `RunFilter`, `PruneRunsFilter`, `TaskRecord`,
`RunRecord`) are the TypeScript types that ship with `@schedjs/core` (and the
storage packages). When in doubt, the `.d.ts` is authoritative.

## The contract

`Storage` from `@schedjs/core` (`packages/core/src/storage.ts`) — 28 methods in
four groups:

- **Tasks** — `upsertTask` (upsert, never duplicates), `getTask`, `listTasks`,
`deleteTask`.
- **Schedules** (schedule-as-entity) — `createSchedule` (dedup-aware:
a second create with the same `dedupKey` updates the existing row, id preserved —
the idempotent upsert handle; returns the stored schedule), `getSchedule`,
`updateSchedule` (partial mid-life patch, idempotent no-op for unknown ids),
`deleteSchedule`, `listSchedules` (`taskName` filter, ordered by id ASC,
paginated with limit/offset).
- **Schedule tick loop / locking** —
`listDueSchedules` (due + unlocked + unpaused + enabled, **per-task ceiling**
— no sibling schedule of the same task locked, ordered
`priority DESC, nextRunAt ASC`), `claimSchedule` (**atomic, exactly-once**, the
per-task ceiling enforced in the same conditional UPDATE), `completeSchedule`
(clear lock, advance `nextRunAt`/`lastRunAt`/`lastRunId`, `failCount += failed`),
`reapZombieScheduleLocks` (unlock stale schedule locks, bump `failCount`),
`refreshScheduleLock` (the engine's heartbeat — extends a claimed schedule's
lock; no-op when not locked), `clearScheduleLocks` (startup recovery). The
task-level twins (`listDueTasks`/`claimTask`/`completeTask`/`reapZombieLocks`/
`refreshLock`/`clearLocks`) remain for manual-run reflection (`completeTask`
writes `lastRunId`/`lastRunAt` on the task row).
- **Run history** — `createRun`, `getRun`, `updateRun` (partial mid-flight),
`finishRun` (terminal: sets `finishedAt` itself), `deleteRun` (idempotent
no-op for unknown runs), `listRuns` (newest-first, `taskName`/`status`
filters, `limit`/`offset`, hard cap 1000), `pruneRuns` (retention sweep:
delete terminal runs of one `temporary` class finished before `olderThan`;
the engine calls it twice — temp class at 24h, regular at 30d).

## The contract suite is the insurance

The shared suite ships as the `@schedjs/core/storage-contract` subpath — the same
~26 tests every shipped adapter runs (SQLite, MySQL, MariaDB, Postgres, Mongo);
run it against yours:

```ts
import { describe, it, expect, beforeEach } from 'vitest'; // your own test runner
import { storageContractTests } from '@schedjs/core/storage-contract';

// pass your vitest api in — the subpath itself has zero runtime dependencies
storageContractTests({ describe, it, expect, beforeEach }, 'my-custom', () => createMyStorage(/* … */));
```

The factory is called **synchronously** per test — pass a factory that returns
the adapter, not a promise. The shipped SQL adapters are async (`createMysqlStorage`
etc.); their own tests `await` the factory once in `beforeEach` and hand the
resolved adapter in. Don't pass `async () => createMyStorage()` directly — the
suite will treat the promise as the adapter.

If it's green, the engine behaves identically on your backend — claiming,
zombie reaping, JSON round-trips, pagination all included.

## The template

Every shipped adapter follows the same shape (mirror the closest dialect):

1. **Row mapping** — snake_case columns ↔ camelCase records; timestamps as
epoch milliseconds; booleans as `0/1` (SQL) or native `BOOLEAN` (Postgres)
or literal `true/false` (Mongo).
2. **Upsert** — `INSERT … ON CONFLICT (name) DO UPDATE SET col = EXCLUDED.col`
(Postgres), `ON DUPLICATE KEY UPDATE col = VALUES(col)` (MySQL/MariaDB),
`replaceOne(…, { upsert: true })` (Mongo).
3. **Atomic claim** — the one query that must be race-free:```ts
// changes/affectedRows/rowCount must be exactly 1
UPDATE scheduled_tasks SET locked_at = $1, updated_at = $2
WHERE name = $3 AND locked_at IS NULL AND paused = false AND disabled = false;
```
4. **JSON round-trip** — `JSON.stringify` on write, `JSON.parse` on read,
`null` ↔ SQL `NULL` (never `'null'`); fields: `config`, `data`, `result`,
`artifacts`, `retry`.
5. **Migrations on open** — a versioned list inside the adapter + a
`sched_schema_version` table, applied idempotently on every open, so a
deployed daemon self-migrates an existing database.

The complete reference — a full in-memory adapter, from scratch to the last
method — is on its own page: [Reference: memory storage](custom/memory-storage). The same code
lives in `packages/core/test/helpers/memory-storage.ts`; `packages/core/src/sqlite.ts`
is the annotated SQL reference.
