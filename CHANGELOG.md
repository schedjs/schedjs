# Changelog

All notable changes to sched. Format follows [Keep a Changelog](https://keepachangelog.com/);
versioning is per-package (monorepo), so entries list the version matrix of the
wave. Prior to the public release the project lived on a private registry —
history is summarized below and fully preserved in the git log.

## [Unreleased]

- **daemon 0.12.1 published** (cancel-on-poll-timeout wave: core 0.53.0 →
  daemon 0.12.1 → npm). Publish:check green for all 9 npm packages;
  docker image pushed separately on the release step.

- **Cancel-on-timeout (core 0.53.0)** — a poll/run timeout is no longer a
  silent stop-polling: when the accepted envelope advertised a `cancelUrl`,
  sched now POSTs `{ runId }` to the worker **before** failing the timed-out
  run, so the worker halts at the next stage boundary instead of finishing
  destructive work after the `failed` verdict was recorded. A failed cancel
  signal is appended to the run error (`cancel signal failed: <reason>`).
  Workers without a `cancelUrl` keep the legacy stop-polling semantics.

- **Sync-health alerts (`sync.failed`)** — the daemon now reports tasks.json
  sync failures over the alerts webhook (`onSyncFailed`, default on): a dead
  storage pool means nothing schedules, so `run.failed` alerts can never fire
  — sync health is the scheduler's own heartbeat. Fires once per failure
  streak (dedupe), resets on heal. Prod lesson 2026-08-24 (books: dead mongo
  pool, tasks not scheduled, no alerts). core 0.52.0 / daemon 0.12.0.
- **daemon 0.11.3 published** (release-hardening wave: core 0.51.0 → daemon
  0.11.3 → sched-daemon docker image + latest). Retention
  regression suite (c3e60c7) + falsy-drop audit landed; publish:check green
  (9 npm + 1 docker).
- **Mongo reconnect ownership (storage-mongo 0.5.1)** — the adapter, not the
  driver's SDAM, owns reconnection. Every storage op is wrapped: a
  connection-class error (`MongoNetworkError` / `MongoNotConnectedError` /
  server-selection / topology-closed) forces a fresh topology
  (`client.close()` + `client.connect()`, which re-resolves DNS) and retries
  (bounded, 2×). Prod lesson (books 2026-08-24): the driver kept `connection 6
  … closed` for hours after the mongo container was recreated — tasks not
  scheduled, no alerts. Non-connection errors propagate unchanged.
- **Release hardening** (for the public release):
  - `--retention-ttl 0` now truly means "retention off": a `0` value reaches
    the engine as `retentionMs: 0` (nullish, not falsy-dropped) and old runs
    are **not** pruned. Previously `0` was dropped and the default TTL applied —
    old runs could be deleted even with retention disabled.
  - `yarn publish:check` — post-publish self-check (`npm view` + `docker
    manifest inspect`) so artifacts that fail to reach the registry are caught
    automatically.
- **Docs**: public-facing cleanup — private registry/host references replaced
  with tokens, README quick start, LICENSE (MIT), CONTRIBUTING (CLA + trademark).

## 2026-08-23 — prod-cutover fixes (daemon 0.11.0 / core 0.50.x / storage-mongo 0.5.0)

First wave driven by production findings from a real deployment:

- **Crash resilience** — engine error boundary around dispatches; admin API
  catches handler errors; Mongo storage reconnects (`MONGO_RETRY_MS`).
- **Sort indexes** on `name` / `startedAt` for run listing.
- **`timeoutMs: -1`** = no timeout (per-task run deadline contract).
- **Log coercion** — run logs normalized to strings.
- **`--retention-ttl 0`** = retention off (see Unreleased for the follow-up fix).

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

## Earlier — foundations (private registry era)

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
