# CLI & daemon

> schedd (daemon) flags, env vars, config + sched (operator CLI) commands, exit codes

Two binaries, one product:

<table>
<thead>
  <tr>
    <th>
      Binary
    </th>
    
    <th>
      Package
    </th>
    
    <th>
      Role
    </th>
  </tr>
</thead>

<tbody>
  <tr>
    <td>
      <code>
        schedd
      </code>
    </td>
    
    <td>
      <code>
        @schedjs/daemon
      </code>
    </td>
    
    <td>
      the process server (SQLite + tasks.json + runners + engine + optional admin api)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        sched
      </code>
    </td>
    
    <td>
      <code>
        @schedjs/cli
      </code>
    </td>
    
    <td>
      the operator CLI — a thin client of the admin api (status/runs/tasks/schedules/trigger/pause/resume) + <code>
        check-worker
      </code>
    </td>
  </tr>
</tbody>
</table>

The daemon's binary was renamed `sched` → `schedd` (docker/dockerd precedent) so
the operator CLI could take the `sched` name. A global install of both packages
no longer collides.

---

# Daemon — `schedd`

A single process: SQLite storage + tasks.json desired state + per-task runners +
engine loops + optional admin server.

> **Node 24 requirement.** `schedd` requires Node >= 24 (`engines`): `node:sqlite`
> is stable there, so the one-line `ExperimentalWarning: SQLite …` that Node 22
> printed on every start is gone.

## Usage

```bash
schedd [--tasks tasks.json] [--db sched.db] [--lock-ttl SECONDS]
       [--lock-heartbeat SECONDS] [--retention-ttl SECONDS] [--temporary-retention-ttl SECONDS]
       [--poll-timeout SECONDS] [--tick-interval MS] [--watchdog-interval MS]
       [--admin-port PORT] [--admin-host HOST] [--storage SPECIFIER]
```

<table>
<thead>
  <tr>
    <th>
      Flag
    </th>
    
    <th>
      Default
    </th>
    
    <th>
      Description
    </th>
  </tr>
</thead>

<tbody>
  <tr>
    <td>
      <code>
        --tasks
      </code>
    </td>
    
    <td>
      <code>
        tasks.json
      </code>
    </td>
    
    <td>
      Path to the desired-state file
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        --db
      </code>
    </td>
    
    <td>
      <code>
        sched.db
      </code>
    </td>
    
    <td>
      SQLite database path — <strong>
        only valid with <code>
          --storage sqlite
        </code>
      </strong>
      
       (XOR: a non-sqlite storage with an explicit <code>
        --db
      </code>
      
       fails fast)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        --storage
      </code>
    </td>
    
    <td>
      <code>
        sqlite
      </code>
    </td>
    
    <td>
      Exactly <strong>
        one
      </strong>
      
       storage (see below)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        --lock-ttl
      </code>
    </td>
    
    <td>
      1800 (30 min)
    </td>
    
    <td>
      Zombie-lock threshold in seconds
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        --lock-heartbeat
      </code>
    </td>
    
    <td>
      600 (10 min)
    </td>
    
    <td>
      Lock refresh cadence for long sync runs, seconds — <strong>
        must be <code>
          < lock-ttl
        </code>
        
         (enforced at parse; the engine throws too)
      </strong>
      
       (default: <code>
        lock-ttl / 3
      </code>
      
      )
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        --retention-ttl
      </code>
    </td>
    
    <td>
      2592000 (30 d)
    </td>
    
    <td>
      Retention TTL for regular terminal runs, seconds from <code>
        finishedAt
      </code>
      
      . <strong>
        <code>
          0
        </code>
        
         = retention off
      </strong>
      
       — terminal runs are kept forever (archive semantics, see <a href="#retention">
        Retention
      </a>
      
      )
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        --temporary-retention-ttl
      </code>
    </td>
    
    <td>
      86400 (24 h)
    </td>
    
    <td>
      Retention TTL for <code>
        temporary
      </code>
      
       runs. <strong>
        <code>
          0
        </code>
        
         = retention off for the temporary class
      </strong>
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        --poll-timeout
      </code>
    </td>
    
    <td>
      1500 (25 min)
    </td>
    
    <td>
      Async (accepted) run ceiling in seconds — must be <code>
        < lock-ttl
      </code>
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        --tick-interval
      </code>
    </td>
    
    <td>
      1000
    </td>
    
    <td>
      Tick cadence in ms (due-task scan)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        --watchdog-interval
      </code>
    </td>
    
    <td>
      60000
    </td>
    
    <td>
      Watchdog cadence in ms (zombie reaping)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        --admin-port
      </code>
    </td>
    
    <td>
      —
    </td>
    
    <td>
      Serve the admin API (<code>
        /api/*
      </code>
      
      ) on this port
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        --admin-host
      </code>
    </td>
    
    <td>
      <code>
        127.0.0.1
      </code>
    </td>
    
    <td>
      Bind host for the admin server
    </td>
  </tr>
</tbody>
</table>

## Environment

<table>
<thead>
  <tr>
    <th>
      Env var
    </th>
    
    <th>
      Description
    </th>
  </tr>
</thead>

<tbody>
  <tr>
    <td>
      <code>
        SCHED_ADMIN_KEY
      </code>
    </td>
    
    <td>
      Bearer key for the admin API/UI. Unset → API open (bind private host!). With a key set, the web UI accepts it via the <strong>
        admin key
      </strong>
      
       field in the header (saved to localStorage) or <code>
        ?token=…
      </code>
      
       on the shell URL
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        DOCKER_HOST
      </code>
    </td>
    
    <td>
      Override the docker CLI context (used by the docker runner)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        MONGO_URL
      </code>
      
       (+<code>
        MONGO_DB
      </code>
      
      )
    </td>
    
    <td>
      Connection string for <code>
        --storage mongo
      </code>
      
      . <code>
        MONGO_DB
      </code>
      
       overrides the db name from the URI path
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        MONGO_RETRY_MS
      </code>
    </td>
    
    <td>
      Startup-connect retry budget for <code>
        --storage mongo
      </code>
      
       (default 30000). The initial connect is retried every 500 ms up to this budget before the daemon fails — a brief mongo restart does not crash-loop the daemon at boot
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        MYSQL_URL
      </code>
    </td>
    
    <td>
      Connection string for <code>
        --storage mysql
      </code>
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        PG_URL
      </code>
    </td>
    
    <td>
      Connection string for <code>
        --storage postgres
      </code>
    </td>
  </tr>
</tbody>
</table>

> **Connection strings live in env / config-volume only — never in arguments.**
> A connstring passed as a flag would leak into the process list (`ps`, `docker inspect`). The startup banner prints the kind + db name only
> (`storage=mongo db=<name>`), never the URL or credentials.

## Storage selection (`--storage`)

The daemon supports exactly **one** storage per process — the `--storage`
specifier (XOR with `--db`, which is the sqlite knob):

<table>
<thead>
  <tr>
    <th>
      Specifier
    </th>
    
    <th>
      Storage
    </th>
    
    <th>
      How it's wired
    </th>
  </tr>
</thead>

<tbody>
  <tr>
    <td>
      <code>
        sqlite
      </code>
      
       (default)
    </td>
    
    <td>
      SQLite file (<code>
        --db
      </code>
      
      )
    </td>
    
    <td>
      built into <code>
        @schedjs/daemon
      </code>
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        mongo
      </code>
    </td>
    
    <td>
      <code>
        @schedjs/storage-mongo
      </code>
    </td>
    
    <td>
      env <code>
        MONGO_URL
      </code>
      
       (+<code>
        MONGO_DB
      </code>
      
      )
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        mysql
      </code>
    </td>
    
    <td>
      <code>
        @schedjs/storage-mysql
      </code>
    </td>
    
    <td>
      env <code>
        MYSQL_URL
      </code>
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        postgres
      </code>
    </td>
    
    <td>
      <code>
        @schedjs/storage-postgres
      </code>
    </td>
    
    <td>
      env <code>
        PG_URL
      </code>
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        <npm-package>
      </code>
      
       / <code>
        <./path>
      </code>
    </td>
    
    <td>
      <strong>
        custom
      </strong>
      
       BYO module
    </td>
    
    <td>
      dynamic import → <code>
        createStorage(env)
      </code>
    </td>
  </tr>
</tbody>
</table>

Built-in kinds (`mongo|mysql|postgres`) resolve to their `@schedjs/storage-*`
package **at runtime** — the package must be present in the image, otherwise
startup fails fast:

```text
schedd: fatal: --storage mongo: add @schedjs/storage-mongo to your image (RUN yarn add @schedjs/storage-mongo)
```

A custom module must export `createStorage(env): Promise<Storage>` — the same
BYO contract as the built-in adapters ([Storage](storage)). `./`, `../`, `/`
prefixes resolve to a filesystem path (relative to the daemon's cwd); anything
else is an npm package.

```bash
MONGO_URL=mongodb://user:pass@db.internal:27017/sched schedd --tasks tasks.json --storage mongo
```

## Signals

<table>
<thead>
  <tr>
    <th>
      Signal
    </th>
    
    <th>
      Behavior
    </th>
  </tr>
</thead>

<tbody>
  <tr>
    <td>
      <code>
        SIGINT
      </code>
      
       (Ctrl+C)
    </td>
    
    <td>
      Graceful stop — engine loops stop, sqlite closes, exit 0
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        SIGTERM
      </code>
    </td>
    
    <td>
      Same graceful stop (POSIX; systemd, docker stop)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        SIGBREAK
      </code>
      
       (Ctrl+Break, win32)
    </td>
    
    <td>
      Same graceful stop — added for Windows operators
    </td>
  </tr>
</tbody>
</table>

On Windows, `taskkill` sends a termination that does **not** always reach a
console process as `SIGTERM` — the reliable paths are Ctrl+C / Ctrl+Break.

## What the daemon does on start

1. Resolves the storage (`--storage`); a non-sqlite storage validates its
connstring env **before** anything starts (missing env → fail-fast).
2. Syncs `tasks.json` into storage (desired state; removed tasks get disabled).
3. Validates every task's runner is registered — a missing runner **aborts startup**:
`task "greet": runner "custom" not implemented in this build (registered: http, docker)`.
4. Starts the tick loop (fires due tasks), the watchdog (reaps zombie locks), the
poll loop (async `accepted` runs), and the retention loop (hourly sweep of
terminal runs past their TTL — `--retention-ttl` / `--temporary-retention-ttl`).

## Retention

Terminal runs (`succeeded` / `failed` / `cancelled`) are pruned by the retention
loop (hourly) once they're past their class TTL, measured from `finishedAt`:

- `temporary` runs → `--temporary-retention-ttl` (default **24 h**);
- regular runs → `--retention-ttl` (default **30 d**).

Set the TTL to **0 to turn retention off for that class** — run history is kept
forever. This is the archive mode for deployments that migrate legacy history
into sched (books: migrated `task_runs` carry old `finishedAt` timestamps, and
with the 30 d default the first hourly pass would silently prune everything
older than a month — `--retention-ttl 0 --temporary-retention-ttl 0` keeps the
archive).

> Note: `0` was added in daemon 0.11.0. Earlier versions had no way to disable
> retention — a migration onto the 30 d default pruned aged history.

## Example

```bash
SCHED_ADMIN_KEY=dev-key schedd \
  --tasks tasks.json \
  --db sched.db \
  --admin-port 8080
```

Then the admin api answers on [http://127.0.0.1:8080/api/](http://127.0.0.1:8080/api/)*. The operator CLI
(`sched status --admin-url http://127.0.0.1:8080/api`) and the web UI
(`npx @schedjs/ui` → `sched-ui serve --proxy http://127.0.0.1:8080`, see
[Admin UI](ui)) both speak to it.

---

# Operator CLI — `sched`

`@schedjs/cli` — a thin projection of the admin REST API ([Admin API](admin-api)):
status, runs, tasks, schedules, trigger, pause/resume. Zero dependencies
(`node:fetch` only); the daemon stays the single owner of state. Machine output
is `--json`; tables are for TTY eyes only.

## Install

```bash
npm install -g @schedjs/cli
```

## Usage

```text
sched <command> [args] [--admin-url URL] [--api-key KEY] [--json]

Commands:
  status                   daemon health + task/schedule/run counts + next runs
  runs [--task T] [--status S] [--limit N] [--offset N]
  tasks
  schedules
  trigger <task> [--data JSON]
  pause <task> | pause --schedule <id>
  resume <task> | resume --schedule <id>
  check-worker <url> [--api-key KEY] [--timeout SECONDS]
```

Global flags:

<table>
<thead>
  <tr>
    <th>
      Flag
    </th>
    
    <th>
      Env
    </th>
    
    <th>
      Default
    </th>
    
    <th>
      Description
    </th>
  </tr>
</thead>

<tbody>
  <tr>
    <td>
      <code>
        --admin-url URL
      </code>
    </td>
    
    <td>
      <code>
        SCHED_ADMIN_URL
      </code>
    </td>
    
    <td>
      <code>
        http://127.0.0.1:8080/api
      </code>
    </td>
    
    <td>
      Admin API base — note the <code>
        /api
      </code>
      
       mount point is already included
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        --api-key KEY
      </code>
    </td>
    
    <td>
      <code>
        SCHED_ADMIN_KEY
      </code>
    </td>
    
    <td>
      —
    </td>
    
    <td>
      Bearer key for the admin API
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        --json
      </code>
    </td>
    
    <td>
      —
    </td>
    
    <td>
      —
    </td>
    
    <td>
      Stable machine-readable JSON contract
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        -h
      </code>
      
       / <code>
        --help
      </code>
      
      , <code>
        -v
      </code>
      
       / <code>
        --version
      </code>
    </td>
    
    <td>
      —
    </td>
    
    <td>
      —
    </td>
    
    <td>
      Help / version
    </td>
  </tr>
</tbody>
</table>

Exit codes: **0** ok / **1** api·network·data error / **2** usage.

`--api-key` before the command is the admin key; after `check-worker` it is the
*worker's* key (a different secret — see below).

## Examples

```bash
sched status                                   # is my daemon alive? next runs?
sched runs --status failed --limit 20 --json   # failed runs as JSON
sched trigger publish-video --data '{"videoId":"v-42"}'
sched pause --schedule channel-ada             # pause one channel's schedule, not the task
sched resume sync-channel-stats
```

`status` composes one view: `/health` + `/tasks` + `/schedules` + a bounded
failed-runs fetch, and lists the five soonest `nextRunAt` schedules.

## PowerShell note

Windows PowerShell 5.1 pipes UTF-16 by default — `ConvertFrom-Json` can garble
UTF-8 JSON from `sched --json`. Use `pwsh` (PS 7, native UTF-8) or `chcp 65001`
in cmd. Quote paths with spaces in examples.

## check-worker — conformance validator

Validates that an HTTP envelope worker ([Runner protocol](protocol)) speaks the
wire contract correctly — a fake-sched client that sends exactly the envelopes
sched sends and checks the answers. Never touches the daemon or the admin api.

```bash
sched check-worker http://127.0.0.1:8081 --api-key $SCHED_API_KEY --timeout 30
```

Six scenarios, each PASS/FAIL:

<table>
<thead>
  <tr>
    <th>
      #
    </th>
    
    <th>
      Scenario
    </th>
    
    <th>
      Check
    </th>
  </tr>
</thead>

<tbody>
  <tr>
    <td>
      1
    </td>
    
    <td>
      Sync success
    </td>
    
    <td>
      POST ping → 200 <code>
        {status:"succeeded"}
      </code>
    </td>
  </tr>
  
  <tr>
    <td>
      2
    </td>
    
    <td>
      Sync failure
    </td>
    
    <td>
      POST with <code>
        data.fail
      </code>
      
       → <code>
        {status:"failed", error}
      </code>
    </td>
  </tr>
  
  <tr>
    <td>
      3
    </td>
    
    <td>
      Async lifecycle
    </td>
    
    <td>
      POST long → 202 accepted → GET statusUrl → running (progress grows) → succeeded, timeout trap
    </td>
  </tr>
  
  <tr>
    <td>
      4
    </td>
    
    <td>
      Auth
    </td>
    
    <td>
      only with <code>
        --api-key
      </code>
      
      : no key → non-2xx, with key → 2xx (skipped otherwise)
    </td>
  </tr>
  
  <tr>
    <td>
      5
    </td>
    
    <td>
      Run-id idempotency
    </td>
    
    <td>
      two dispatches with the same run id → identical envelope
    </td>
  </tr>
  
  <tr>
    <td>
      6
    </td>
    
    <td>
      Dirty input
    </td>
    
    <td>
      garbage body → worker answers 4xx/500 and stays alive (re-ping works)
    </td>
  </tr>
</tbody>
</table>

Verdict: `N/N PASS`, exit 0 all-green / 1 a scenario failed / 2 usage.
`--json` prints `{ ok, pass, fail, scenarios: [{name, pass, skipped, detail}] }`.

Worker contract for scenarios 1–5: `POST` with `content-type: application/json`,
`x-sched-run-id` (the idempotency key), optional `x-sched-api-key`, body
`{ task: { name, config }, data }` — exactly what the HTTP runner dispatches
(see [HTTP runner](runners/http) and the examples in `examples/workers/`).
