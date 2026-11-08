# Changelog

All notable changes to sched. The format follows [Keep a Changelog](https://keepachangelog.com/);
versioning is per-package (monorepo), so every release lists the versions it shipped.

## [0.57.0] — 2026-11-08

core 0.57.0 · storage-mongo 0.6.1 · storage-mysql 0.6.0 · storage-postgres 0.6.0 ·
admin-api 0.5.0 · mcp 0.6.1 · ui 0.4.1 · daemon 0.13.4 · cli 0.3.1

### Added

- **`disabledBy` — the reason a task or schedule is disabled.** `'sync'` means
  sync parked it because the rule left `tasks.json`; `'operator'` means someone
  stopped it by hand; `null` on rows created before this release (read as
  operator intent). Exposed by the admin API, the MCP schedule tools and the
  dashboard.
- **`effectiveStatus: 'disabled'`** — a disabled schedule, or a schedule whose
  task is disabled, is never reported as `active`. The dashboard shows ⛔ and
  `sched schedules` prints `disabled` in the PAUSED column.

### Changed

- **A rule that returns to `tasks.json` schedules again.** Sync disables a rule
  it finds missing from the file, and now clears that mark when the rule comes
  back — recomputing `nextRunAt` from now, with no catch-up burst. An operator
  stop is never cleared by sync. Previously a rule that briefly left the file
  stayed parked forever while the schedule list and the boot log still looked
  healthy.
- **Additive migrations only:** SQLite adds the column on open, MySQL and
  PostgreSQL run migration 9, MongoDB needs nothing. Rows parked by earlier
  releases carry no mark, so they are treated as operator intent and need one
  manual `enableTask`.

### Fixed

- Package build scripts call `yarn run -T tsc` instead of a bare `tsc`: on Linux
  the root `.bin` is not on `PATH`, so `yarn workspaces foreach … run build`
  failed with `command not found: tsc`.

## [0.56.0] — 2026-09-21

core 0.56.0 · storage-mongo 0.6.0 · storage-mysql 0.5.0 · storage-postgres 0.5.0 ·
admin-api 0.4.0 · mcp 0.6.0 · ui 0.4.0 · daemon 0.13.3 · cli 0.3.0

### Added

- **Pause the whole queue without stopping the daemon.** `engine.pause()` /
  `resume()` (`isPaused()`, `getPauseInfo()`) freeze claiming only: `tasks.json`
  sync, retention, the poll loop and alerts for runs already in flight keep
  working. Boot frozen with `createDaemon({ startPaused: true })` or
  `SCHED_START_PAUSED=1`. Resume is **skip, not catch-up** — a slot that came
  due during the pause moves to its next future slot, while overdue `once` and
  delayed runs play exactly once. Events `queue-paused` / `queue-resumed`
  (the latter carries `{ pausedMs, skippedSchedules, deferredRuns }`).
- **Queue control plane:** `GET /queue`, `POST /queue/pause|resume` (idempotent,
  never `409`), a `queue:` line in `sched status`, and `pause_queue` /
  `resume_queue` MCP tools.
- **Run filters:** `GET /runs?since=&until=&runner=` (ISO-8601 on the wire,
  relative forms such as `24h` in the CLI), `400` on an unparseable timestamp
  or unknown `status`, backed by `idx_runs_started` in every adapter.
- **Bulk operations:** `POST /runs/bulk/cancel|retry` return a partial result
  (`{ ok, failed: [{ id, reason }] }`) — never atomic, so one racing run cannot
  block the rest. `sched cancel <id...>` / `retry <id...>` exit `1` if any id
  failed.

### Changed

- Dashboard: run filters (task / since / until / runner, kept across paging),
  bulk cancel/retry with per-id reasons, and a queue widget in the header.

## [0.55.0] — 2026-09-20

core 0.55.0 · admin-api 0.3.3 · mcp 0.5.2 · daemon 0.13.2 · cli 0.2.0

### Added

- **Streak alerts (`AlertsConfig.onStreak`).** One `run.failed` per failure
  streak instead of one per failed run; a success emits `run.succeeded` with
  `previousFailures` (the "recovered" signal) and resets the streak. `onStreak:
  1` (default) keeps the old per-run behaviour. The streak lives in engine
  memory: a daemon restart forgets an open streak, so the next failure alerts
  again — an alert is never lost.
- `sched tasks` gained a FAILS column (per-task failure count, schedules
  included).

### Fixed

- `POST /tasks/:name/run` with invalid `data` answers `400` instead of `500`:
  admin-api and mcp no longer carry a duplicate copy of `@schedjs/core`, so
  `instanceof InputValidationError` works.

## [0.54.0] — 2026-09-19

core 0.54.0 · admin-api 0.3.2 · mcp 0.5.1 · storage-mongo 0.5.1 ·
storage-mysql 0.4.2 · storage-postgres 0.4.2 · ui 0.3.1 · daemon 0.13.1 ·
cli 0.1.2

First release published to the public npm registry.

- **MCP control plane:** the tool set grew from 9 to 18 — schedule CRUD
  (`get/create/update/pause/resume/delete_schedule`), run lifecycle
  (`cancel_run`, `retry_run`) and `delete_task`.
- **`inputSchema` in `TaskDefinition`:** declare the shape of run `data` as a
  JSON Schema subset (types, bounds, `enum`, `required`, `default`,
  `description`). The engine validates `data` on schedule create/update and
  `run_once` (400 with the offending paths), applies defaults, and the admin UI
  and MCP render forms from the schema.

> Earlier releases (`daemon@0.13.0`, `mcp@0.5.0`, `admin-api@0.3.1`,
> `storage-mysql@0.4.1`, `storage-postgres@0.4.1`) are broken on npm — their
> manifests leaked the `workspace:*` protocol and a fresh `npm i` fails on them.

## Earlier releases

- **Cancel-on-timeout (core 0.53.0).** A poll/run timeout no longer stops
  polling silently: when the worker advertised a `cancelUrl`, sched POSTs
  `{ runId }` to it before failing the timed-out run, so the worker halts at the
  next stage boundary instead of finishing destructive work after the failure
  was recorded. A failed cancel signal is appended to the run error. Workers
  without a `cancelUrl` keep the legacy semantics.
- **`sync.failed` alerts (core 0.52.0 / daemon 0.12.0).** tasks.json sync
  failures are reported over the alerts webhook (`onSyncFailed`, on by default):
  a dead storage pool means nothing schedules, so `run.failed` can never fire —
  sync health is the scheduler's own heartbeat. Fires once per failure streak,
  resets on heal.
- **Mongo reconnect ownership (storage-mongo 0.5.1).** The adapter, not the
  driver's SDAM, owns reconnection: every operation is wrapped, and a
  connection-class error forces a fresh topology (re-resolving DNS) with a
  bounded retry. Drivers can keep a closed connection for hours after the server
  is recreated — long enough to stop scheduling without any alert. Non-connection
  errors propagate unchanged.
- **`--retention-ttl 0` truly means "retention off"** — `0` reaches the engine as
  `retentionMs: 0` instead of being falsy-dropped and replaced by the default
  TTL, so old runs are no longer deleted with retention disabled.
- **`yarn publish:check`** — post-publish self-check (`npm view` plus
  `docker manifest inspect`) so artifacts that fail to reach a registry are
  caught automatically.

## 2026-08-23 — prod-cutover fixes (daemon 0.11.0 / core 0.50.x / storage-mongo 0.5.0)

First wave driven by production findings from a real deployment:

- **Crash resilience** — engine error boundary around dispatches; admin API
  catches handler errors; Mongo storage reconnects (`MONGO_RETRY_MS`).
- **Sort indexes** on `name` / `startedAt` for run listing.
- **`timeoutMs: -1`** = no timeout (per-task run deadline contract).
- **Log coercion** — run logs normalized to strings.
- **`--retention-ttl 0`** = retention off (the falsy-drop was fixed later — see the retention entry above).

## 2026-08-22 — dispatch view + daemon image from npm (daemon 0.10.x / core 0.49.0 / storage-* 0.4.0)

- **Dispatch view** — `triggerTask` / `retryRun` now apply per-run data/body
  overrides the same way scheduled dispatches do (previously manual/retry runs
  carried the raw task config).
- **`--storage` bridge** — the daemon selects its storage adapter from the CLI
  (`--storage mongo|mysql|postgres|<custom module>`); credentials come from env
  (`MONGO_URL` / `MYSQL_URL` / `PG_URL`), never from process arguments. BYO
  adapters via `createStorage(env)` helpers (`@sched/storage-*` 0.4.0).
- **Official Docker image built from npm** — `FROM @sched/daemon` composition,
  `docker-cli` included (Docker runner works inside the container).

## 2026-08-21 — cancellation that reaches the worker (core 0.47–0.48 / daemon 0.7–0.9)

- **`cancelUrl` channel** — async workers can opt into receiving a cancel
  signal: sched `POST`s `{runId}` to `cancelUrl` before finishing the run as
  cancelled. Without `cancelUrl`: legacy stop-polling (documented).
- **Cancel observability** — `[cancel]` log lines (`cancel-sent` / `cancel-ack`
  / `cancel-failed` / `cancel-no-channel`) for debugging.
- **Dispatcher fix** — the daemon now forwards cancel to the per-task runner
  (previously the cancel signal never left the daemon when the runner was
  wrapped by the dispatcher).

## 2026-08-20 — run deadlines + HTTP runner hardening (core 0.45–0.46 / daemon 0.6.0)

- **Per-task run deadline** (`timeoutMs`): `-1` = never auto-terminate
  (default when absent), `>0` = forced failure after N ms, `absent` = legacy.
  Storage schema migration to v6 (`timeout_ms`).
- **HTTP runner**:
  - Envelope responses from broken workers → run `failed` (not silent success).
  - Relative `statusUrl` resolves against `config.url`.
  - Transient poll errors (network / 5xx / 408 / 429) retried (2 × 500 ms).

## 2026-08-18 — control plane + CLI (admin-api 0.1.0 / cli 0.1.0 / daemon 0.3.x)

- Admin REST control plane extracted into `@sched/admin-api` (OpenAPI spec,
  typed client).
- Operator CLI `@sched/cli` (`sched status`), `schedd` entry junction-safe.
- Node engine floor raised to `>= 24` in the daemon wave (`>= 22.5` in core for
  `node:sqlite`).

## Earlier — foundations

- **Engine** (`@sched/core`): queue-based execution, retries with backoff,
  priority, run history, `onRunFinal` alerts, lock/heartbeat, live-sync
  recovery, internal/process runners.
- **Storages**: SQLite (default), MariaDB/MySQL, PostgreSQL, MongoDB — split
  into per-adapter packages with a shared contract suite.
- **Admin API** (`@sched/admin-api`): tasks/runs/schedules REST, Bearer auth,
  triggered-by forwarding.
- **MCP server** (`@sched/mcp`): 9 tools over the admin API, stdio + Streamable
  HTTP, `--readonly` guard.
- **Web UI** (`@sched/ui`): standalone `sched-ui serve`, embeddable web
  components.
- **Runner protocol**: request/response envelope, async runs via `statusUrl`
  polling, idempotency via `x-sched-run-id`, outbound auth (`x-sched-api-key`).
- **Docker / SSH / process runners**; `config.network` for Docker runner.
- **Docs**: Docus 5 site, `llms.txt` for AI agents, self-hosting + security guides.
