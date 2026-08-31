# sched admin client — Python (generated)

Live verification of the `openapi-spec` claim: **«клиент на любом ЯП одной
командой»** — a working admin-API client in a non-TS/JS language generated
strictly from the published OpenAPI spec.

| | |
|---|---|
| Language | Python 3 (no TS/JS by task design) |
| Generator | `openapi-generator` 7.24.0 (`-g python`), as named in the docs |
| Input spec | `openapi.json` — `@schedjs/admin-api/openapi.json`, npm **0.2.0** subpath export (identical to the repo copy) |
| Verified against | published `@schedjs/daemon` **0.3.5**, live stand on `:8127` (no auth, scratch sqlite) |
| Coverage | all **15 paths / 21 operations** of the spec + error paths (400/404/409) |
| Method | TDD — test suite written first (RED: no client), generator run (GREEN), 24/24 passing, re-runs stable |
| Raw adapter | **none** — every operation deserializes through the generated typed client (F&F round 2, spec 0.2.0) |

## Layout

```
openapi.json        published spec, pinned (source of truth for this example)
generate.ps1        the one command — regenerate the client from the spec
sched_admin_client/ generated client package (checked in, out-of-the-box usable)
tests/              pytest suite: every documented path exercised against a live stand
smoke.py            live smoke — one F&F row per path (what/expected/got)
```

## Use

```bash
# deps
pip install -r requirements.txt pytest

# point at a live stand (default http://127.0.0.1:8127/api)
SCHED_ADMIN_URL=http://127.0.0.1:8127/api python -m pytest tests/ -v

# live smoke (F&F table)
python smoke.py --url http://127.0.0.1:8127/api
```

A minimal client call:

```python
from sched_admin_client import ApiClient, Configuration
from sched_admin_client.api import TasksApi

api = TasksApi(ApiClient(Configuration(host="http://127.0.0.1:8127/api")))
for t in api.list_tasks().tasks:
    print(t.name, t.runner)
```

## F&F — what / expected / got

| # | Path | Ops | Expected (spec) | Got (live 0.3.5) | Verdict |
|---|---|---|---|---|---|
| 1 | `/health` | GET | `{ok:true, uptimeMs, version}` | same, `version=0.3.5` | ✅ |
| 2 | `/tasks` | GET | `{tasks: TaskRecord[]}` | list incl. seeded task | ✅ |
| 3 | `/tasks` | POST | 201 create / 200 upsert | 201 → 200, idempotent | ✅ |
| 4 | `/tasks/{name}` | GET / DELETE | 200 TaskRecord / 204→404 | as expected | ✅ |
| 5 | `/tasks/{name}/run` | POST | 200 `{run}` | 200, run `succeeded` | ✅ |
| 6 | `/tasks/{name}/pause\|resume` | POST | 200, paused flips | 200, `true→false` | ✅ |
| 7 | `/runs` | GET | `{runs: RunRecord[]}` + filters | list + `task=` filter | ✅ |
| 8 | `/runs/{id}` | GET / DELETE | 200 RunRecord / 204→404 | as expected | ✅ |
| 9 | `/runs/{id}` `?logFromOffset` | GET | incremental chunk | `{logChunk, logTotalLength}` | ✅ |
| 10 | `/runs/{id}/retry` | POST | 200 `{run}` new run | new id, same task | ✅ |
| 11 | `/runs/{id}/cancel` | POST | 200 cancelled / 409 finished | 409 on finished, 200 in-flight→cancelled | ✅ |
| 12 | `/runs/{id}/artifacts/{idx}` | GET | 200 bytes / 404 | 404 (no artifacts on scratch stand) | ✅ |
| 13 | `/schedules` | GET | `{schedules: ScheduleRecord[]}` | list | ✅ |
| 14 | `/schedules` | POST | 201 / 200 dedup-upsert (id preserved) | 201→200, same id | ✅ |
| 15 | `/schedules/{id}` | GET / PATCH / DELETE | 200 / rule merge / 204→404 | as expected (cron `*/5`→`*/10`) | ✅ |
| 16 | `/schedules/{id}/pause\|resume` | POST | 200, paused flips | 200, `true→false` | ✅ |

Suite: **24/24** (typed-only, three consecutive runs). Smoke: **19/19**.

> **Auth note.** With `SCHED_ADMIN_KEY` set, `/health` is **open** (no auth —
> probe for compose healthcheck/LB) and every other route 401s without the
> key. Verified live against a keyed 0.3.5 instance: `/health` → 200,
> `/tasks` → 401 without key, 200 with `Bearer dev-key`. This closes F-1.

## Round-2 fixes verified (F-1..F-5 from the round-1 report, spec 0.2.0)

- **F-1 · `/health` auth contradiction — FIXED (server).** Keyed daemon 0.3.5:
  `GET /api/health` → 200 open; `/api/tasks` → 401 without key, 200 with.
- **F-2 · wrapped responses — FIXED (spec).** Mutation responses now declare
  `{task}` / `{run}` / `{schedule}` (TaskMutation / RunMutation /
  ScheduleMutation components); `GET /runs/{id}?logFromOffset` declares
  RunLogChunk (RunRecord allOf + logChunk/logTotalLength). The generated
  client deserializes every one of them natively — `raw_ops.py` is **deleted**.
  Decorated fields added: `TaskRecord.lastRunStatus`,
  `ScheduleRecord.lastRunStatus/effectiveStatus`.
- **F-3 · `const: true` — FIXED.** Removed from the spec; `Health200Response.ok`
  is a plain `StrictBool` again (no string enum).
- **F-4 · `Schedule` oneOf — FIXED.** Flat output schema
  (`kind` + optional `cron/timezone/ms/at`); `ScheduleRecord.schedule.kind`,
  `.cron`, `.ms`, `.at` read directly off the typed model. Normalization
  verified live: `once` → `{kind:"once", at:ISO}`, `interval` → `{kind:"interval", ms}`.
- **F-5 · dedupKey fail-fast — FIXED (server).** POST `/schedules` with an
  unknown top-level field → **400** with a message naming the field; PATCH
  `/schedules/{id}` with `taskName` (or any unknown field) → **400**.
  Verified live against 0.3.5.

Retest procedure used: `generate.ps1` against the 0.2.0 tarball spec
(byte-identical to the pinned `openapi.json`), typed-only pytest suite 24/24,
typed-only smoke 19/19, plus live curls for F-1/F-5 against a keyed stand.

## Reproduce

```powershell
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-25.0.2.10-hotspot"
.\generate.ps1            # one command, from this folder
pip install -r requirements.txt pytest
SCHED_ADMIN_URL=http://127.0.0.1:8127/api python -m pytest tests/ -v
```

Stand used for the retest (published artifact, not the stale `:8123` dev build —
that one predates `POST /tasks` and the schedule-as-entity format):

```
node "C:\nvm4w\nodejs\node_modules\@sched\daemon\dist\entry.js" ^
  --tasks tasks.json --db acpy.db --admin-port 8127
```
