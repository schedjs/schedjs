# What's new

Version history for sched, newest first. Versioning is **per-package** (monorepo),
so each wave lists the version matrix it shipped. The full, commit-level history
lives in the repository [`CHANGELOG.md`](https://github.com/schedjs/schedjs/blob/main/CHANGELOG.md).

## In development — streak alerts (core / cli)

- **alerts.onStreak — one alert per incident, not one per run.** A task that
keeps failing sends a single `run.failed` when the streak reaches
`onStreak` consecutive failures (payload carries `consecutiveFailures`); the
failures inside the streak stay silent, a success breaks the streak, and the
next incident alerts again. The recovery signal («отпустило») is a
`run.succeeded` payload carrying `previousFailures` — how many failures the
success ended (send it by adding `'succeeded'` to `on`). Default
`onStreak: 1` = every terminal failure alerts, i.e. exactly the behaviour
before this option, so an existing deployment is not silently re-tuned.
- **FAILS column in sched tasks.** How long a task has been red, without a
single reminder: `onStreak` suppresses the repeats, the CLI keeps the running
count visible (zero prints as `—`). `--json` is unchanged (`failCount` was
already in the task record).
- **tasks.json alert validation, root block included.** The top-level `alerts`
block is now validated by the same rules as the per-task blocks (it used to be
cast through unchecked): `onStreak` must be an integer ≥ 1, `onSyncFailed` a
boolean, `on`/`onMissed`/`webhook` as before — a typo fails at load instead of
silently changing what alerts.

## In development — inputSchema (core)

- **inputSchema in TaskDefinition** — declare the shape of run `data`
(tenant parameters) as a JSON Schema subset: types, `min`/`max`, `minLength`/
`maxLength`, `minItems`/`maxItems`, `enum`, `required`, `default` and
`description`. The engine validates `data` at `create_schedule` /
`update_schedule` / `run_once` (400 with detailed issues), applies defaults,
and the admin UI / MCP render forms from the schema (trigger.dev model).
`input_schema` is persisted on the task row (sqlite v0.9, mysql/pg v7; mongo
is schemaless).

## 2026-08-26 — cancel-on-poll-timeout wave (core 0.53.0 / daemon 0.12.1)

- **Cancel-on-timeout** — a poll/run timeout is no longer a silent stop-polling:
when the accepted envelope advertised a `cancelUrl`, sched POSTs `{ runId }`
to the worker **before** failing the timed-out run, so the worker halts at the
next stage boundary instead of finishing destructive work after the `failed`
verdict was recorded. A failed cancel signal is appended to the run error
(`cancel signal failed: <reason>`). Workers without a `cancelUrl` keep the
legacy stop-polling semantics.

## 2026-08-25 — sync health + release hardening (core 0.52.0 / daemon 0.12.0 / storage-mongo 0.5.1)

- **Sync-health alerts (sync.failed)** — the daemon reports tasks.json sync
failures over the alerts webhook (`onSyncFailed`, default on): a dead storage
pool means nothing schedules, so `run.failed` alerts can never fire — sync
health is the scheduler's own heartbeat. Fires once per failure streak
(dedupe), resets on heal. Prod lesson 2026-08-24.
- **Mongo reconnect ownership** — the adapter, not the driver's SDAM, owns
reconnection: connection-class errors force a fresh topology
(`client.close()` + `client.connect()`) and retry (bounded, 2×).
- **Release hardening** — `--retention-ttl 0` truly means "retention off"
(previously `0` was falsy-dropped and the default TTL applied); `yarn publish:check` verifies artifacts reached the registry after publish; public
docs cleanup (README quick start, LICENSE MIT, CONTRIBUTING).

## 2026-08-23 — prod-cutover fixes (daemon 0.11.0 / core 0.50.x / storage-mongo 0.5.0)

First wave driven by production findings from a real deployment:

- **Crash resilience** — engine error boundary around dispatches; admin API
catches handler errors; Mongo storage reconnects (`MONGO_RETRY_MS`).
- **Sort indexes** on `name` / `startedAt` for run listing.
- **timeoutMs: -1** = no timeout (per-task run deadline contract).
- **Log coercion** — run logs normalized to strings.
- **--retention-ttl 0** = retention off.

## 2026-08-22 — dispatch view + daemon image from npm (daemon 0.10.x / core 0.49.0 / storage-* 0.4.0)

- **Dispatch view** — `triggerTask` / `retryRun` apply per-run data/body
overrides the same way scheduled dispatches do.
- **--storage bridge** — the daemon selects its storage adapter from the CLI
(`--storage mongo|mysql|postgres|<custom module>`); credentials come from env,
never from process arguments. BYO adapters via `createStorage(env)` helpers.
- **Official Docker image built from npm** — `FROM @sched/daemon` composition,
`docker-cli` included (Docker runner works inside the container).

## 2026-08-21 — cancellation that reaches the worker (core 0.47–0.48 / daemon 0.7–0.9)

- **cancelUrl channel** — async workers can opt into receiving a cancel
signal: sched `POST`s `{runId}` to `cancelUrl` before finishing the run as
cancelled. Without `cancelUrl`: legacy stop-polling (documented).
- **Cancel observability** — `[cancel]` log lines (`cancel-sent` / `cancel-ack`
/ `cancel-failed` / `cancel-no-channel`).
- **Dispatcher fix** — the daemon forwards cancel to the per-task runner
(previously the signal never left the daemon when the runner was wrapped).

## 2026-08-20 — run deadlines + HTTP runner hardening (core 0.45–0.46 / daemon 0.6.0)

- **Per-task run deadline** (`timeoutMs`): `-1` = never auto-terminate (default
when absent), `>0` = forced failure after N ms, `absent` = legacy. Storage
schema migration to v6 (`timeout_ms`).
- **HTTP runner**: envelope responses from broken workers → run `failed` (not
silent success); relative `statusUrl` resolves against `config.url`; transient
poll errors (network / 5xx / 408 / 429) retried (2 × 500 ms).

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
