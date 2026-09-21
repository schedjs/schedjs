# Changelog

All notable changes to sched. Format follows [Keep a Changelog](https://keepachangelog.com/);
versioning is per-package (monorepo), so entries list the version matrix of the
wave. Prior to the public release the project lived on a private registry —
history is summarized below and fully preserved in the git log.

## [Unreleased]

- **R2+R3+R4 — пауза очереди, окно ранов, массовые операции** (волна core
  **0.56.0** → storage-mongo **0.6.0** / storage-mysql **0.5.0** /
  storage-postgres **0.5.0** → admin-api **0.4.0** → mcp **0.6.0** →
  ui **0.4.0** → daemon **0.13.3** → cli **0.3.0**).
  - **Очередь на паузе, демон на ходу.** `engine.pause()` / `resume()`
    (`isPaused()` / `getPauseInfo()`) замораживают только клейм: синк
    `tasks.json`, retention/prune, poll-loop и алерты по уже идущим ранам
    продолжают работать. Старт замороженным — `createDaemon({ startPaused: true })`
    или `SCHED_START_PAUSED=1` (флага CLI намеренно нет). Снятие — **skip, не
    catch-up**: слот, наступивший внутри паузы, уезжает в следующий будущий без
    `missed-slot`, а просроченные `once`/delayed-раны и pending-ретраи играют
    ровно один раз. События `queue-paused` (`{ pausedAt, startPaused }`) и
    `queue-resumed` (`{ pausedMs, skippedSchedules, deferredRuns }`).
  - **Контур управления очередью.** `GET /queue` → `{ paused, pausedAt, startPaused }`,
    `POST /queue/pause|resume` → `200` и идемпотентно (никогда не `409`);
    `sched status` печатает строку `queue:` (`active` / `paused (since …, start-paused)`);
    MCP — `pause_queue` / `resume_queue` (мутации, под `--readonly` выключены).
    Состояние очереди намеренно не уехало в `GET /health`: liveness отвечает за liveness.
  - **Окно ранов: `RunFilter += since / until / runner`.** `GET /runs?since=&until=&runner=`
    (ISO-8601 на проводе; `sched runs --since 24h --until 2h --runner docker`
    разворачивает относительную форму на клиенте), плюс fail-fast **400** на
    неразбираемый timestamp и на неизвестный `status` (`?status=bogus` раньше
    отдавал пустой список, что читается как «фейлов нет»). Окно — по `startedAt`,
    обе границы включительные; цена прямо оговорена: долгий ран, стартовавший
    ДО `since`, в список не попадёт, даже если упал внутри окна. Во всех
    адаптерах — `idx_runs_started` (идемпотентный DDL на открытии в sqlite,
    v8-миграция в mysql/postgres, в mongo переиспользован существующий
    `{ startedAt: -1 }` — обходится в обратную сторону).
  - **Массовые cancel/retry.** `POST /runs/bulk/cancel|retry` с `{ ids: [...] }`
    отвечает **частичным** результатом `{ ok, failed: [{ id, reason }] }` —
    никогда не атомарно, чтобы один гоняющийся cancel не блокировал остальные 99;
    причины `not-found | already-terminal | not-cancellable`, `400` на пустое/чужое
    тело и **422** сверх 100 id. CLI принимает ту же пачку: `sched cancel <id...>` /
    `retry <id...>`, код выхода **1**, если хоть один id не прошёл. В MCP массовых
    тулов намеренно нет — агент крутит `cancel_run` / `retry_run`.
  - **Почему в волне даемон.** `@schedjs/mcp` — единственная не-`workspace`
    зависимость в дереве (`apps/daemon`: `^0.5.1`), а caret на 0.x не покрывает
    `0.6.0`, поэтому daemon **0.13.3** — патч без нового кода, только перепин
    (`^0.6.0`). Ради адаптеров волна и идёт: у `storage-mongo 0.5.1` под
    патчем лежала вложенная копия core 0.53.0 — после 0.6.0/0.5.0 дерево
    потребителя резолвит один core.
  - **Дашборд (`@schedjs/ui 0.4.0`).** Фильтры ранов в строке над списком
    (`task` / `since` / `until` / `runner`, окно по `started_at`, включительные
    границы): живут в состоянии компонента — **переживают пагинацию**, а `clear`
    сбрасывает все четыре. Массовые **cancel/retry** по чекбоксам строк:
    результат **частичный и честный** — ок-счётчик плюс каждый проваленный id с
    причиной (`not-found` / `already-terminal` / `not-cancellable`, `no-answer`
    достраивается на клиенте, поэтому id не пропадает молча); проваленные
    остаются отмеченными — это ровно та работа, которая не сделалась. В шапке —
    виджет очереди `queue: active` / `queue: paused (since …)` с одной кнопкой
    pause/resume поверх идемпотентных роутов. Доки — `11.ui.md`.
  - Доки: `00.whats-new.md`, `05.runs.md`, `10.admin-api.md`, `12.mcp.md`,
    `13.cli.md`, `14.self-hosting.md`, `08.storage/*`.

- **R1 — стрик-алерты: один сигнал на серию фейлов + «отпустило»** (волна
  core **0.55.0** → admin-api **0.3.3** → mcp **0.5.2** → daemon **0.13.2** →
  cli **0.2.0**). `AlertsConfig.onStreak`
  (целое ≥ 1; дефолт 1 = прежнее поведение — алерт на каждый терминальный фейл)
  шлёт `run.failed` **ровно один раз на серию**: на ран, где
  `consecutiveFailures === onStreak`; внутри серии тишина, успех разрывает серию, и
  следующий инцидент стреляет снова. Восстановление — `run.succeeded` с
  `previousFailures` («отпустило»), гейтится существующим `on`: с дефолтным
  `on: ['failed']` релиз-сигнала нет — добавьте `'succeeded'`, чтобы его получать;
  `cancelled` не считается ни фейлом, ни восстановлением. Серия живёт в памяти
  движка (`Storage`-контракт не менялся): рестарт демона забывает незакрытую серию,
  поэтому следующий фейл алертит ещё раз — алерт не теряется, это принятая цена.
  Валидация `tasks.json` теперь покрывает и корневой блок `alerts` (`onStreak` —
  целое ≥ 1, `onSyncFailed` — boolean). CLI: колонка `FAILS` в `sched tasks`.
  Доки — `09.logging.md`, `14.self-hosting.md`, `00.whats-new.md`.

  Почему в волне пять пакетов, а не три: `workspace:*` в манифестах
  разворачивается при упаковке в точную версию, поэтому core 0.55.0
  без перепина соседей давал в дереве потребителя ДВЕ копии core —
  engine бросал `InputValidationError` из 0.55.0, а admin-api ловил класс
  из 0.54.0 и `instanceof` не срабатывал (`POST /tasks/:name/run` с
  невалидным `data` отвечал 500 вместо 400). admin-api **0.3.3** и mcp
  **0.5.2** — патчи без нового кода: они пинят core 0.55.0 (у mcp заодно
  уезжает фикс баннера версии — `VERSION` читается из `package.json`,
  а не из хардкода). Адаптеры `storage-*` оставлены на 0.54.0: они
  импортируют core только как типы (`import type`), рантайм-связи и
  проверок идентичности там нет, а свои изменения они получат в волне 2
  вместе с `RunFilter`.

- **Публичный npm-релиз (2026-09-19)** — core 0.54.0, ui 0.3.1, cli 0.1.2,
  storage-mongo 0.5.1, daemon 0.13.1, mcp 0.5.1, admin-api 0.3.2,
  storage-mysql 0.4.2, storage-postgres 0.4.2. Внимание: tarball'ы
  `daemon@0.13.0` / `mcp@0.5.0` / `admin-api@0.3.1` / `storage-mysql@0.4.1` /
  `storage-postgres@0.4.1` на npm нерабочие (в манифест утёк протокол
  `workspace:*`) — свежий `npm i` на них падает; используйте версии выше.
  Версии публичного npm для этих пяти пакетов на один патч выше версий
  внутреннего реестра (волна 2026-08-30).

- **Волна 0.54.0/0.13.0 опубликована на npm** (2026-08-30): core 0.54.0,
  daemon 0.13.0, mcp 0.5.0, admin-api 0.3.1, ui 0.3.1, storage-mysql/pg 0.4.1;
  publish:check npm-часть зелёная, install-smoke OK. Docker-образ — отдельный
  VDS-шаг.

- **@schedjs/mcp full control-plane (task:1364)** — tools grown from 9 to 18:
  schedule CRUD (`get/create/update/pause/resume/delete_schedule`), run
  lifecycle (`cancel_run`, `retry_run`), `delete_task`. `data`/inputSchema
  validation flows through to the admin API.

- **inputSchema in TaskDefinition (core)** — declare the shape of run `data`
  (tenant parameters) as a JSON Schema subset (types, min/max, minLength/
  maxLength, minItems/maxItems, enum, required, default, description). The
  engine validates `data` at create_schedule / update_schedule / run_once
  (400 with detailed issues), applies defaults, and the admin UI / MCP render
  forms from the schema (trigger.dev model). `input_schema` persisted on the
  task row (sqlite v0.9, mysql/pg v7).

- **daemon 0.12.1 published** (cancel-on-poll-timeout wave: core 0.53.0 →
  daemon 0.12.1 → npm). Publish:check green for all 9 npm packages;
  docker image pushed separately on the VDS release step.

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
  0.11.3 → `ghcr.io/schedjs/sched-daemon:0.11.3` + latest). Retention
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
