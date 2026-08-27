---
title: Storage
navigation:
  title: Overview
description: The pluggable storage contract — SQLite, MySQL/MariaDB, Postgres, Mongo, or build-your-own
---

sched talks to persistence through a single `Storage` contract. SQLite is the default
(embedded, zero-config, shipped inside `@schedjs/core`); MySQL/MariaDB, Postgres and Mongo
are separate adapter packages you install when history must live elsewhere (shared prod
DB, multi-replica).

| Backend | Package | Driver | Page |
|---|---|---|---|
| SQLite (default) | `@schedjs/core` | built-in (`node:sqlite`) | [sqlite](/docs/storage/adapters/sqlite) |
| MySQL / MariaDB | `@schedjs/storage-mysql` | `mysql2` (one driver, both dialects) | [mysql](/docs/storage/adapters/mysql) |
| Postgres | `@schedjs/storage-postgres` | `pg` | [postgres](/docs/storage/adapters/postgres) |
| Mongo | `@schedjs/storage-mongo` | `mongodb` | [mongo](/docs/storage/adapters/mongo) |
| Anything else | your own adapter | any driver | [custom](/docs/storage/custom) |

Each adapter is a thin package over the same contract: install it, pass it to
`createEngine` / `createDaemon`, done. Versions are independent, so an adapter can
move at its own pace without forcing a core bump.

### The CLI-ready surface — `createStorage(env)`

Every adapter package also exports a `createStorage(env: NodeJS.ProcessEnv):
Promise<Storage>` helper — the **same** BYO contract a custom adapter uses (see
[custom](/docs/storage/custom)). It reads its own connection-string env vars and
returns a ready `Storage`:

| Package | Reads | Returns |
|---|---|---|
| `@schedjs/storage-mongo` | `MONGO_URL` (+`MONGO_DB`, fallback db name from the URI path) | adapter over a connected mongo client |
| `@schedjs/storage-mysql` | `MYSQL_URL` | adapter over a mysql2 pool |
| `@schedjs/storage-postgres` | `PG_URL` | adapter over a pg pool |

```ts
import { createStorage } from '@schedjs/storage-mongo';

const storage = await createStorage(process.env); // reads MONGO_URL / MONGO_DB
createDaemon({ tasksPath: 'tasks.json', storage });
```

The daemon binary uses the same helper for `--storage mongo|mysql|postgres`
(see [CLI](/docs/cli#storage-selection-storage)) — it never imports the drivers, only
this one function. Connection strings are read from env, never passed as
arguments.

## What the contract covers

- **Tasks** — upsert/list/get, claim (locking), pause/resume, disable
- **Schedules** — create (dedup-aware upsert), get/update/delete, list (per-task filter)
- **Runs** — create, mid-flight update (`progress`/`log`/`result`), terminal finish,
  list with filters, get, delete; every run carries `scheduleId` (which schedule fired)
- **Locking** — atomic claim + release (zombie reaping by `lockTtlMs`)

Storage adapters ship with a **contract test-suite** — the same tests run against SQLite,
MySQL/MariaDB, Postgres and Mongo, so parity is enforced, not assumed.

## Run-record schema

Runs are stored as full records. The fields split into four groups:

**Identity & lifecycle**

- `id` — run UUID
- `taskName` — the task that ran
- `runner` — `'http' | 'docker' | 'internal' | custom`
- `status` — `queued | running | succeeded | failed | cancelled`
- `startedAt` / `finishedAt` — timestamps (`finishedAt` null while running)

**Data & outcome**

- `data` — run parameters snapshot at dispatch (JSON)
- `result` — final result reported by the worker (JSON)
- `error` — error message, null on success
- `progress` — 0–100, written mid-flight
- `log` — captured stdout/stderr, soft-capped
- `artifacts` — `ArtifactRef[]` (S3 keys, email receipts, URLs)
- `workerRef` — statusUrl (http) / container id (docker)

**Run metadata**

- `trigger` — `'schedule'` (the tick) or `'manual'` (`triggerTask` / retry)
- `triggeredBy` — caller identity of a manual run (null for schedule runs)
- `temporary` — retention class: true = 24h TTL, false = 30d
- `retryOf` — predecessor run id (manual retry / engine auto-retry); null = fresh
- `attempt` — 1-based attempt within the retry cycle (1 = first try)
- `scheduleId` — the schedule that fired the run (null for manual runs)

**Relations**

- Tasks carry `lastRunId` (retry-linking); schedules carry `lastRunId` too (their
  own last run). `data`/`result`/`artifacts` are JSON columns (`null` ↔ SQL `NULL`).
