# Introduction

> What sched is and how it works

**sched** is a cron scheduler done right: **reliable delivery**, **run history**, and a
**web UI** — self-hosted, queue-based, polyglot-ready.

## Why sched

"Fire and forget" is not enough for a scheduler. sched's promise — **the scheduler knows
everything about every run**:

- **Input** — with what parameters the task was invoked (`data`)
- **Progress** — 0–100 progress and captured stdout/stderr log
- **Outcome** — JSON result, error, artifacts (S3 keys, email receipts, URLs)
- **Lifecycle** — `queued → running → succeeded | failed | cancelled`, timestamps, duration

Runs survive restarts, locks are reaped, and every run is recorded in the storage — SQLite
by default, or MySQL/MariaDB, Postgres or Mongo when history must live in an existing
database (each is a separate package, see [Storage](storage)).

## Key features

- **Cron scheduling** with timezone support (`tz`) and DST-safe next-run calculation
- **Run history** (`RunRecord`): `data`, `result`, `error`, `progress`, `log`, `artifacts`
- **Pluggable storage** — SQLite first (in `@schedjs/core`), MySQL/MariaDB, Postgres and
Mongo as separate adapter packages, all with a contract test-suite
- **Polyglot runners** — HTTP, Docker, and any custom runner you write against the `Runner` contract
- **Embedded mode** — schedule in-process functions with the internal runner; no daemon, no Docker (see [quick start](quick-start#1-embedded-schedule-functions-in-process))
- **Retries with backoff** — `retry: { maxAttempts, backoffMs, multiplier }` per task; a *persistent* failure is one where retries ran out
- **Idempotent dispatch** — `x-sched-run-id` on the wire; workers dedupe by run id
- **Async runs** — `202 accepted` + polling for long-running jobs
- **Admin API** + **web UI** (web components) — see runs, tasks, status

## Three ways to run

Pick by scale — the engine underneath is the same, so run history, retries and alerts
work on every path:

1. **Embedded** — schedule functions in-process, zero infra (SQLite file + handlers).
2. **Standalone daemon** — own process with HTTP/Docker workers, admin UI, alerts.
3. **Docker** — the daemon in a container, compose-friendly, self-hosting.

See [Quick start](quick-start) to run your first task on any of them.

sched is not the right tool for every scheduling problem. [Comparison](comparison) puts it
next to BullMQ, Bull, Kue, Bee, pg-boss and Agenda and says where it wins, where it loses,
and what to use instead.

## Architecture

```text
tasks.json (desired state)
                    │ sync
                    ▼
   ┌────────────┐   tick/watchdog/poll    ┌───────────────────────────────┐
   │   Engine   │ ──────────────────────▶ │      Runners (execution)      │
   │ (scheduler)│   claim → run → record  │ http · docker · process · ssh │
   │            │                         │ mcp · internal · custom       │
   └─────┬──────┘                         └───────────────────────────────┘
         │ storage seam
         ▼
   ┌───────────────────────┐    ┌──────────────────────────────────────┐
   │        Storage        │    │  Daemon (CLI + Admin API + UI)       │
   │ sqlite/mysql/pg/mongo │    │ --admin-port · SCHED_ADMIN_KEY       │
   └───────────────────────┘    └──────────────────────────────────────┘
```

- **Engine** — deterministic tick loop + zombie watchdog over the storage seam. Claims due
tasks, dispatches to the runner, records outcomes, reaps stale locks.
- **Runners** — own *how* a task runs. HTTP (request/response, sync or `accepted` + poll),
Docker (container spawn), or your own in-process function.
- **Storage** — the `Storage` contract: tasks, runs, locking. SQLite, MySQL/MariaDB,
Postgres and Mongo implement it.
- **Daemon** — loads `tasks.json` (desired state), syncs it, runs the engine, serves the
admin API and the web UI.

## Where to go next

- [Comparison](comparison) — sched next to BullMQ, Agenda, pg-boss and friends
- [Quick start](quick-start) — run your first scheduled task in 3 minutes
- [Tasks](tasks) — the `tasks.json` format and scheduling
- [Runs](runs) — the run lifecycle and `RunRecord`
- [Runners](runners/http) — HTTP / Docker / custom runners
- [Protocol](protocol) — the wire contract between sched and workers
