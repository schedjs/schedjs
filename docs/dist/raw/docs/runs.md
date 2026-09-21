# Runs

> The run lifecycle and RunRecord

Every execution of a task is a **run** — recorded in storage, visible in the admin UI
and the API. This is sched's promise: the scheduler knows everything about every run.

## RunRecord

```ts
interface RunRecord {
  id: string;                 // UUID — idempotency on the wire
  taskName: string;
  runner: string;             // 'http' | 'docker' | custom
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  data: unknown | null;       // run parameters snapshot at start
  result: unknown | null;     // final result reported by the worker
  error: string | null;
  progress: number | null;    // 0–100, written mid-flight
  log: string | null;         // captured stdout/stderr, soft-capped
  artifacts: ArtifactRef[] | null;  // { kind: 's3'|'email'|'url'|'file', ref, label }
  workerRef: string | null;   // statusUrl (http) / container_id (docker)
  attempt: number;            // 1-based attempt within the retry cycle (1 = first try)
  trigger: 'schedule' | 'manual'; // how the run was launched — the tick, or an explicit trigger/retry
  triggeredBy: string | null; // who launched a manual run (email/identity); null for schedule runs
  scheduleId: string | null;  // the schedule that fired this run; null = manual/trigger
  temporary: boolean;         // retention class: true = short TTL (24h), false = long (30d)
  retryOf: string | null;     // predecessor run id (manual retry / engine auto-retry); null = fresh
  startedAt: Date;
  finishedAt: Date | null;
}
```

`data` is a snapshot of the run parameters taken at dispatch: from the **schedule's**`data` for a schedule-fired run (falling back to the task's `config.data` /
`config.body` when the schedule carries none), or from the task's defaults for a
manual trigger — merged with the caller's `{ data }` override
(`triggerTask(name, { data })` → `{ ...config.data, ...data }`, books one-off
parity). The worker receives the same snapshot the run record carries: at dispatch
the runner's payload (`config.data`/`config.body`) is overridden with the run data
when the run carries explicit data, so a manual trigger's override and a retry's
snapshot reach the worker — not just the audit trail. `scheduleId` answers "which
schedule shot" — per-tenant usage counting falls out of it for free.

## Run metadata

Four first-class fields:

- **trigger** — `'schedule'` (fired by the tick) or `'manual'` (`triggerTask` / manual retry).
- **triggeredBy** — caller identity of a manual run. sched is identity-agnostic:
the caller supplies it (`triggerTask(name, { triggeredBy })`); the admin api
forwards `{ triggeredBy }` from the run/retry bodies (null when omitted).
- **temporary** — retention class, per-invocation. A temporary run is pruned after
24h, a regular one after 30d. Manual retries inherit the original's class.
- **retryOf** — the predecessor run: the retried run (manual retry) or the failed
attempt (engine auto-retry, linked through `task.lastRunId`). Together with
`attempt` this forms a connected chain: attempt = position, retryOf = predecessor.

## Retention

The engine sweeps terminal runs (`succeeded | failed | cancelled`) on its own
cadence — no daemon-only cron needed, embedded engines stay clean too:

- `temporary: true` runs older than **24h** (`temporaryRetentionMs`) are deleted.
- regular runs older than **30d** (`retentionMs`) are deleted.

`runRetentionOnce()` runs the sweep on demand; the daemon's retention loop calls
it hourly (configurable via `retentionIntervalMs`). Non-terminal runs are never
pruned by the sweeper — the watchdog handles zombie locks instead.

## Filtering run history

`listRuns` (the seam the admin API's `GET /runs` sits on) filters by
`taskName`, `status`, `runner` and a start-time window:

```ts
await storage.listRuns({
  taskName: 'greet',
  status: 'failed',
  runner: 'docker',
  since: new Date('2026-09-19T00:00:00Z'),
  until: new Date('2026-09-20T00:00:00Z'),
  limit: 50,
});
```

The same filters travel up the stack: `GET /runs?since=&until=&runner=` on the
admin API (ISO-8601), `sched runs --since 24h --until 2h --runner docker` on the
CLI (relative forms resolved client-side to ISO — see [CLI](cli)), and the
`since`/`until`/`runner` arguments of the MCP `list_runs` tool (see [MCP](mcp)).

**Why the window goes on startedAt** — both bounds inclusive
(`since <= startedAt <= until`). `startedAt` is the column `listRuns` already
orders by, it is never null, and the new `idx_runs_started` index lives on it; a
`finishedAt` window would silently drop every `queued`/`running` run — exactly the
rows you open the history for. The same choice is what `taskName + startedAt`
(`idx_runs_task`) already does for per-task reads.

**The price, stated honestly**: a long run that started *before* `since` and
failed *inside* the window is **not** listed — the window bounds starts, not
finishes. "What failed in the last 24h?" misses a 30-hour job that died an hour
ago; widen `since` (or drop the lower bound) when auditing long runners. Same
reason a wide `until` buys nothing for that case.

## Manual retry

`POST /runs/:id/retry` (admin api) re-executes a run: the new run gets
`data = run.data` (the original snapshot, not task defaults), `retryOf = run.id`,
`trigger = 'manual'`, `temporary` inherited from the original, and a fresh
`triggeredBy` — and the worker is dispatched with the original snapshot, not the
task defaults. The original run is never modified — the audit trail stays intact.

## Lifecycle

```text
claimed          dispatched              worker reports
  ───────────▶ ───────────▶ ────────────────────▶ ──────────────────▶
  (created)     queued        running               succeeded | failed | cancelled
                (async:       (worker started)     (terminal)
                 accepted
                 + poll)
```

- **Sync runs** — the worker answers within the request: outcome is terminal immediately.
- **Async runs** — the worker answers `202 accepted` with a `statusUrl`; the run goes
`queued`, then `running`, and the engine polls until a terminal response (or
`pollTimeoutMs`, default 25 min, is exceeded → `failed`).
- **Cancelled** — timeout escalation in the docker runner (SIGTERM → SIGKILL), an
explicit cancel, or startup recovery (see below). User cancel (`POST /runs/:id/cancel`) aborts the runner via `hooks.signal` — the worker is really
stopped (process/docker/ssh kill, http abort), not just re-labelled. A `queued`
async run is cancelled by **signalling the worker first**: when the accepted
envelope advertised a `cancelUrl`, sched POSTs `{ runId }` there and the worker
stops at the next stage boundary (see [Runner protocol → Cancel](protocol#cancel));
without one, cancel = drop from the poll queue (the worker may finish on its own
— the run record says so honestly), schedule advanced, lock released.
- **Timeout** — the same worker signal is sent on auto-termination. When an async
run hits its `pollTimeoutMs` or per-task `timeoutMs` ceiling, sched POSTs
`{ runId }` to the advertised `cancelUrl` **before** failing the run, so the
worker stops at the next stage boundary instead of finishing destructive work
after the `failed` verdict was already recorded. A worker without a `cancelUrl`
is left to finish on its own (legacy stop-polling); a failed cancel signal is
appended to the run error.

## Restart recovery

A restart in the middle of a long run used to leave a **ghost** `running`/`queued`
run forever: the poll queue is in-memory (lost), `pruneRuns` only touches terminal
runs, and the zombie watchdog only reaps *task locks* — the run record stayed
`running` with `finishedAt = null`. The daemon now recovers on start
(`engine.recoverOrphanRuns()`):

- every `running`/`queued` run left by the previous process → **cancelled** with
`error: "daemon restarted — orphaned run recovered"` (visible in the UI/API
history, not a silent hole);
- every task lock → **released immediately** (no waiting for `lockTtl`);
- `failCount` is **not** bumped — an interrupted run is an infrastructure event,
not a task failure;
- the affected tasks re-dispatch on the next tick (catch-up) — at-least-once
intact.

The recovery fires the `recovered-orphans` engine event (see
[Logging → Engine events](logging#_3-engine-events-claim-dispatch-retry-zombie-reap))
and is safe with the lock heartbeat: a heartbeat only lives in a live process, so
at startup every lock is by definition orphaned.

## Long runs and the lock heartbeat

A **sync run longer than lockTtlMs** (default 30 min) would otherwise be reaped by
the zombie watchdog mid-flight — the lock ages past the TTL while the worker is still
alive, the next tick re-dispatches the task, and two parallel runs happen. The engine
prevents that by refreshing the task's lock
**every lockHeartbeatMs** (default `lockTtlMs / 3` = 10 min at the default)
while the run is in flight, so the watchdog only ever reaps genuinely dead locks:

- **Daemon alive, run alive** → heartbeat keeps `lockedAt` fresh → no reap, no
duplicate dispatch.
- **Daemon down** → heartbeat stops → the lock ages past `lockTtlMs` → the
watchdog reaps it on restart → the run re-dispatches. At-least-once intact.

Trade-off: a *hung* sync run whose heartbeat still fires keeps its lock fresh — the
heartbeat is liveness, not a timeout. The ceiling for a hung run stays at the
**runner level** (process / docker / http / ssh `timeoutMs`); there is no engine-level
sync timeout. If your sync workers have no runner timeout, a truly wedged worker
blocks the task until the daemon restarts — set the runner timeouts.

Async (`accepted`) runs are covered by a different invariant: `pollTimeoutMs`
(default 25 min) is documented **must be < lockTtlMs**, so the poll fails a hung
run before the watchdog could reap its lock. The heartbeat targets the sync path,
which has no ceiling of its own.

Configure via `--lock-heartbeat SECONDS` (daemon) or `lockHeartbeatMs`
(embedded `createEngine` / `createDaemon`).

## Failures are recorded, not silent

- Worker error → `failed` with `error` and whatever `log` was captured.
- Missing runner → fail-fast: `runner "X": not implemented in this build`.
- Poll errors (non-2xx, malformed envelope) → throw → run `failed`.
- Task `failCount` increments; the schedule stays on schedule (its next run still fires).

A terminal run can also push a **status alert** (webhook) — see
[Self-hosting → Status alerts](self-hosting#status-alerts); the alert fires on the
final, exhausted failure, not on retries ([Tasks → retry](tasks#retry)).

## What's in the log

`log` is the captured stdout/stderr of the worker, soft-capped (docker: ring-buffer,
default 10 KB; http: whatever the envelope reports).

## Artifacts — who generates what

sched does **not** generate artifacts. Reports, uploads, emails — that's the runner's
job: it has the data and the credentials. sched only **stores what the runner reports**
and shows it in the UI.

```ts
// ArtifactRef — returned by the runner in the envelope
{ kind: 's3' | 'email' | 'url' | 'file', ref: 's3://bucket/key', label: 'Report' }
```

<table>
<thead>
  <tr>
    <th>
      kind
    </th>
    
    <th>
      ref example
    </th>
    
    <th>
      meaning
    </th>
  </tr>
</thead>

<tbody>
  <tr>
    <td>
      <code>
        s3
      </code>
    </td>
    
    <td>
      <code>
        s3://my-bucket/task-reports/a/run123.md
      </code>
    </td>
    
    <td>
      object key in object storage (Minio/S3)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        email
      </code>
    </td>
    
    <td>
      message id / mailto:
    </td>
    
    <td>
      email sent by the worker (receipt, not content)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        url
      </code>
    </td>
    
    <td>
      <code>
        https://...
      </code>
    </td>
    
    <td>
      external link
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        file
      </code>
    </td>
    
    <td>
      local path
    </td>
    
    <td>
      local artifact (docker runner output)
    </td>
  </tr>
</tbody>
</table>

The runner uploads the artifact to wherever it wants (S3, email, webhook) and hands
sched the reference. sched persists `artifacts` on the RunRecord and the admin UI links
to them.

**Reading artifacts** — two modes:

- **Direct URL** (default): the UI links straight to `ref` (`s3://`, `https://`).
Works when the artifact is public or the client has access.
- **Proxy** (optional): if the daemon has object-storage credentials, an
authorized route `GET /api/runs/:id/artifacts/:idx` streams the object so the bucket
can stay private.

**Failure is soft**: a worker that can't upload (S3 down) should still finish the run
and report the problem in `error`/`result` — a missing artifact must not fail the run
by itself.

**Idempotency**: on a retry, re-use the existing artifact (`ref` already set) instead
of re-generating.
