# Tasks

> The tasks.json format — schedules, runners, config

Tasks are defined in a `tasks.json` file — the **desired-state contract**. The daemon
syncs it into storage on start: tasks that exist in the file are created/updated, removed
tasks are disabled.

## Structure

```json
{
  "tasks": [
    {
      "name": "publish-video",
      "runner": "http",
      "label": "Publish video",
      "description": "Publishes the rendered video to the platform",
      "schedules": [{ "cron": "0 9 * * *", "timezone": "Europe/Berlin" }],
      "config": {
        "url": "https://studio.example.com/api/publish",
        "method": "POST",
        "auth": { "apiKey": "secret" }
      }
    }
  ],
  "alerts": {
    "on": ["failed"],
    "onMissed": true,
    "webhook": {
      "url": "https://hooks.example.com/ops",
      "secret": "whsec_…"
    }
  }
}
```

The file has three top-level blocks: `tasks` (the definitions), optional `runners`
(sandbox ceilings, see [Runner config](#runner-config)) and optional `alerts`
(platform-level status webhooks — see [Self-hosting → Status alerts](self-hosting#status-alerts)).
A programmatic `createDaemon({ alerts })` option overrides the file's `alerts` block.

### Per-task alert routing

The root `alerts` block is the **channel + defaults** for the whole daemon. A task can
**override its routing** with its own `alerts` block — field-wise merge over the root,
**the task wins, arrays replace** (they are never concatenated):

```json
{
  "tasks": [
    {
      "name": "publish-video",
      "runner": "http",
      "alerts": { "on": ["failed"] }
    },
    {
      "name": "generate-thumbnail",
      "runner": "internal",
      "alerts": { "on": [] },
      "schedules": [{ "cron": "0 2 * * *" }]
    }
  ],
  "alerts": {
    "on": ["failed"],
    "onMissed": true,
    "webhook": { "url": "https://hooks.example.com/ops", "secret": "whsec_…" }
  }
}
```

- `generate-thumbnail` has `alerts.on: []` — a failing cosmetic run stays silent,
while `publish-video` (no override) keeps the root default `on: ["failed"]`.
- `alerts.onMissed: false` opts a task out of [missed-slot](self-hosting#status-alerts)
alerts; `alerts.webhook` routes that task to a **different channel** (e.g. a critical
task pages PagerDuty while the rest go to Slack).
- A task without an `alerts` block uses the root defaults — no behavior change.
- Malformed task `alerts` (bad status, non-boolean `onMissed`, webhook without a
string `url`) fails at load, not on runs.

## Priority, retry and the run deadline

Three engine-level fields control *how* a task runs — they work with every runner.

### Run deadline (`timeoutMs`)

Force-termination contract: after how long may sched give up on a run that isn't
finishing on its own.

| Value | Meaning |
|---|---|---|
| `-1` (default when omitted) | **Never auto-terminate.** The run lives until it finishes or is manually cancelled (`POST /runs/:id/cancel`). For long pipelines that may go silent for hours |
| `> 0` | Force-fail the run this many **milliseconds** after it starts (sync: abort via the runner's signal; async: the poll ceiling) |

```json
{ "name": "ozon-seller-pipeline", "timeoutMs": -1, "config": { "url": "http://worker/run" } }
```

`timeoutMs` **defaults to -1 when omitted** — a task that may run for hours
without reporting progress is never killed automatically; only the operator
can, via cancel. Write an explicit positive `timeoutMs` only when you *want* a
force-fail deadline (e.g. a stuck worker must fail loudly after N minutes).

### Trigger-only tasks (no schedule)

`schedules` is **optional**. A task without it is a **trigger-only** task: it never
fires on a tick (`nextRunAt` stays `null`), stays visible in task lists, and runs
only when triggered manually — `POST /tasks/:name/run` (admin api) or
`triggerTask` (embedded). Use it for on-demand operations that have no cron
(e.g. re-encoding a video when the source changed):

```json
{ "name": "re-encode-video", "config": { "url": "http://worker/tasks/re-encode" } }
```

### Multiple schedules per task (schedule-as-entity)

A task declares **one or more** schedules via `schedules: [...]` — each element is one
firing rule with its own `data`, `externalId`/`dedupKey`, and policy overrides. One
task + one schedule **per channel**, each carrying its own `{ "channelId": "UC-…" }`
run parameters:

```json
{
  "name": "sync-channel-stats",
  "config": { "url": "http://worker/tasks/sync-stats" },
  "schedules": [
    {
      "cron": "0 9 * * *",
      "data": { "channelId": "UC-ada" },
      "externalId": "ada",
      "dedupKey": "channel-ada"
    },
    {
      "cron": "0 9 * * *",
      "data": { "channelId": "UC-sam" },
      "externalId": "sam",
      "dedupKey": "channel-sam"
    }
  ]
}
```

- A schedule-fired run dispatches with the **schedule's data** (manual `POST /tasks/:name/run` keeps the task's defaults).
- `externalId` is the tenant key (userId/orgId) — multi-tenancy from the first line.
- `dedupKey` is the **idempotent upsert key**: creating a schedule with a key that
already exists updates that schedule instead of duplicating it. Must be unique across
the file (duplicates fail at load).
- `retry`/`priority` at the schedule level override the task's (`schedule ?? task`
resolution — never a partial merge). Effective policy is materialized onto the
schedule row at sync (entry ?? task default) and at API create (`POST /schedules`), so a single-schedule task carries its task-level policy onto its
row. An entry that doesn't set `priority`/`retry` inherits the task default;
an explicit `0` priority is honored as-is (not treated as «unset»).
- **Runtime state lives on the schedule row**: `nextRunAt`/`lastRunAt`/
`failCount`/`retryCount`/lock advance there — a schedule-fired run takes its
`data` from the schedule (falling back to the task's defaults when unset), and
its `RunRecord.scheduleId` names the schedule that fired it.
- **Per-task ceiling 1**: a task's schedules are serialized — while one schedule
of a task is locked (in flight), its siblings are neither due nor claimable.
The contract «a task never runs twice» is preserved.

### `priority`

Non-negative integer (default `0`). Among due tasks, higher priority runs first
(ties break by due time). With `maxConcurrent > 1`, priority determines claim order.
A scheduled publish must beat a background transcode batch in the queue:

```json
{
  "name": "publish-video",
  "priority": 10,
  "schedules": [{ "cron": "0 9 * * *" }],
  "config": { "url": "..." }
}
```

A schedule that doesn't set `priority` inherits the task's — the effective value
is materialized onto the schedule row at sync and at `POST /schedules`. An
explicit `priority: 0` on the entry wins over a task-level default.

### `retry`

Pulling analytics from an API that rate-limits: retry with backoff instead of
failing the run.

```json
{
  "name": "sync-channel-stats",
  "schedules": [{ "cron": "*/15 * * * *" }],
  "config": { "url": "..." },
  "retry": { "maxAttempts": 3, "backoffMs": 60_000, "multiplier": 2 }
}
```

- `maxAttempts` — **total** attempts budget (1 = no retries, the failure is final).
- `backoffMs` — delay before the first retry; each consumed retry multiplies it by
`multiplier` (default `1` = fixed backoff). **Required** in the `retry` object
(write `0` when you don't retry, e.g. `{ "maxAttempts": 1, "backoffMs": 0 }`).
- On a failed run with retries left, the engine schedules another attempt at
`now + backoff` instead of advancing the schedule. The failed run is still
recorded (with its `attempt` number); `failCount` is **not** bumped yet.
- A **persistent failure** is one where retries ran out — only then is the run
counted (`failCount++`) and only then do alerts / `onRunFinal` fire. This is the
contract the AI-operator trigger builds on: N persistent fails in a window, not
N failed attempts.
- A manual `triggerTask` never auto-retries — an explicit human trigger is a
one-shot, its result alerts immediately.

## Fields

<table>
<thead>
  <tr>
    <th>
      Field
    </th>
    
    <th>
      Type
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
        name
      </code>
    </td>
    
    <td>
      string
    </td>
    
    <td>
      —
    </td>
    
    <td>
      Unique task name. Runs are recorded against it
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        runner
      </code>
    </td>
    
    <td>
      string
    </td>
    
    <td>
      <code>
        "http"
      </code>
    </td>
    
    <td>
      Which runner executes the task (http / docker / internal / custom)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        schedules
      </code>
    </td>
    
    <td>
      array
    </td>
    
    <td>
      —
    </td>
    
    <td>
      Optional. One or more firing rules, each with its own <code>
        data
      </code>
      
      /policy. Omit → <strong>
        trigger-only
      </strong>
      
       task (never due, launched manually / from the API)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        tz
      </code>
    </td>
    
    <td>
      string
    </td>
    
    <td>
      <code>
        "UTC"
      </code>
    </td>
    
    <td>
      IANA timezone for cron wall-clock semantics (applies to schedules that don't set their own)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        config
      </code>
    </td>
    
    <td>
      object
    </td>
    
    <td>
      —
    </td>
    
    <td>
      Runner-specific config, validated per runner at load (fail-fast)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        priority
      </code>
    </td>
    
    <td>
      number
    </td>
    
    <td>
      <code>
        0
      </code>
    </td>
    
    <td>
      Task-level scheduling priority — the default for schedules that don't override it (engine feature)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        retry
      </code>
    </td>
    
    <td>
      object
    </td>
    
    <td>
      —
    </td>
    
    <td>
      Task-level retry policy: <code>
        { maxAttempts, backoffMs, multiplier? }
      </code>
      
       — the default for schedules that don't override it (engine feature)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        timeoutMs
      </code>
    </td>
    
    <td>
      number
    </td>
    
    <td>
      <code>
        -1
      </code>
    </td>
    
    <td>
      Run-deadline contract: <code>
        -1
      </code>
      
       (default) = never auto-terminate (manual cancel only), <code>
        > 0
      </code>
      
       = force-fail after N ms (see <a href="#run-deadline-timeoutms">
        Run deadline
      </a>
      
      )
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        label
      </code>
    </td>
    
    <td>
      string
    </td>
    
    <td>
      —
    </td>
    
    <td>
      Human-readable label (admin UI); the engine ignores it
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        description
      </code>
    </td>
    
    <td>
      string
    </td>
    
    <td>
      —
    </td>
    
    <td>
      Longer description (admin UI); the engine ignores it
    </td>
  </tr>
</tbody>
</table>

## Schedule kinds

Exactly one schedule key per `schedules` element — anything else fails at load:

```json
{ "cron": "0 9 * * *" }          // cron expression, wall-clock in the schedule's tz
{ "interval": "every 5 minutes" } // human interval (also: "every 1 hour", "every day at 09:00")
{ "once": "tomorrow at noon" }    // one-shot: fires once, then unschedules
```

- `timezone` may sit inside the cron element (`{ "cron": "...", "timezone": "..." }`); it is
hoisted to that schedule's `tz`.
- One-shot (`once`) schedules fire once; `nextRunAt` becomes `null` after firing.
- Every element may also carry `data`, `externalId`, `dedupKey`, `retry`, `priority`
(see [Multiple schedules per task](#multiple-schedules-per-task-schedule-as-entity)).

## Runner config

Config is opaque to the engine and validated per runner at load time — a bad config
aborts the daemon with a clear error instead of failing at runtime. Runners opt in via
the optional `validateConfig` hook (see [Custom runners](runners/custom)): the docker
runner, for example, aborts startup when a task's image is outside the runner's allowlist.

- **http** — `url`, `method`, `headers`, `body`, `envelope`, `data`, `auth` — see
[HTTP runner](runners/http)
- **docker** — `image`, `tag`, `command`, `args`, `env`, `data`, `timeoutMs`, `maxLogKb` —
see [Docker runner](runners/docker). Note the runner-level `config.timeoutMs`
also accepts `-1` = no container timeout (since daemon 0.11.0), mirroring the
task-level run-deadline `-1`
- **custom** — whatever your runner's config shape is — see [Custom runners](runners/custom)

## Pause — two levels (AND semantics)

Pause exists on **both** the task and the schedule. A schedule-fired run fires iff
`!task.paused && !schedule.paused`:

- `task.paused` — the **family stop** (repair window): stops every schedule of
the task at once. `resumeTask` clears only this level.
- `schedule.paused` — **one instance** (pause a single channel): stops just that
schedule. `resumeSchedule` clears only its level.

`resume(task)` does not unpause schedules and vice versa — the UI shows the
**effective** status (🔴 task-paused / 🟡 schedule-paused) so «снял паузу, а оно
молчит» never happens. A pending retry is a due run of the schedule — pausing
gates it too; unpausing re-arms it.

## Sync semantics

`tasks.json` is the source of truth on start:

- new task → created (scheduled from its first `nextRunAt`)
- changed task → updated in place
- removed task → **disabled** (kept in history, never ticks again; re-adding it
to the file keeps it disabled — enable via `taskOps` in embedded code)

The daemon **re-syncs on a live interval** (default 60 s, `syncIntervalMs`): an
edit to `tasks.json` is picked up without a restart — same create / update /
disable-on-remove semantics, runtime state preserved unless the schedule changed.
A **broken file at runtime is ignored with a log** (last good state stays, the
daemon keeps running); fail-fast applies only to the startup load. Force a
re-sync on demand with `daemon.runSyncOnce()`.

The engine does **not** back-fill missed slots: a task whose `nextRunAt` is in the past
fires once on the next tick, then reschedules from *completion time*.

**Long tasks and the lock TTL.** A sync run longer than `lockTtlMs` (default 30 min)
keeps its lock via the engine's heartbeat (`lockHeartbeatMs`, default `lockTtlMs / 3` =
10 min) — it is never reaped mid-flight by the zombie watchdog. The watchdog only
reaps locks whose heartbeat died (daemon down). The hung-run ceiling is the runner's
own `timeoutMs` (process / docker / http / ssh), not the lock TTL. See
[Runs → Long runs and the lock heartbeat](runs#long-runs-and-the-lock-heartbeat).

**Runtime registration.** Tasks can also be created / updated / rescheduled at runtime
via the admin API — `POST /tasks` (full definition, `schedules: [...]` supported) and
`POST /schedules` (one firing rule at a time, same validation as `tasks.json`, no
restart). Runtime-registered tasks are **not** file-managed: sync never disables them
(they survive live re-syncs and restarts) — remove one with `DELETE /tasks/:name`. See
[Admin API → Runtime registration](admin-api#runtime-registration-post-tasks).
