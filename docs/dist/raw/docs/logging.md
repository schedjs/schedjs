# Logging & observability

> Run logs, terminal events, engine events — what sched logs and how to wire your own

sched separates **three levels** of observability: run logs (stored with each run),
terminal events (a hook per finished run), and engine events (claim/dispatch/retry —
the wiring is yours today).

## 1. Run logs — what a run did

Each `RunRecord` carries a `log` field — the captured output of that run:

- **Internal runner** — `ctx.log(line)` in your handler appends to the run's log;
`ctx.setProgress(percent)` reports progress. A thrown handler carries the log lines
collected so far into the failed run.
- **Docker runner** — the container's stdout/stderr are captured into a ring buffer
(soft-capped by `maxLogKb`) and attached to the run on completion.
- **HTTP runner** — the run's `log` is whatever the worker reports back via the poll
envelope (`{ status: 'running', log: '...', progress: 50 }`).

Run logs are stored, not streamed — read them back anytime:

```ts
const runs = await storage.listRuns({ taskName: 'generate-thumbnail', limit: 10 });
for (const r of runs) console.log(r.log, r.status, r.attempt);
```

## 2. Terminal events — `onRunFinal`

The `onRunFinal` hook fires once per run reaching a **terminal** state
(`succeeded` / `failed` / `cancelled`) — with the finished `RunRecord` and the
run's **streak context**: `previousFailures`, the number of terminal failures
that preceded it (0 = a fresh incident). Wire it to your logger, metrics, or the
built-in status alerts (`createAlerts` — webhook):

```ts
const engine = createEngine({
  // ...
  onRunFinal: (run, { previousFailures }) => {
    console.log(`[sched] ${run.taskName} ${run.status} attempt=${run.attempt} after ${previousFailures} failure(s) ${run.error ?? ''}`);
  },
});
```

Two semantics worth knowing:

- **Retries defer the hook.** A failed run with retries left does *not* fire — the alert
lands only on the **final, exhausted** failure (that's what "persistent failure"
means; see [Tasks → retry](tasks#retry)).
- **Manual triggers always fire** — `triggerTask` is a one-shot, its result alerts
immediately, and it never auto-retries.

### Streak context — why alerts fire once per incident

`previousFailures` is the engine's snapshot of a task's **consecutive terminal
failures before this run**, taken before the terminal write. Only alert-eligible
runs move it: a failure with a retry still scheduled is not an incident yet, and
a `cancelled` run neither counts nor breaks a streak (a human acted, not the
pipeline). A `succeeded` run resets it.

`createAlerts` (`onStreak`, see [Self-hosting → Status alerts](self-hosting#status-alerts))
uses it to send **one** message per incident instead of one per run:

<table>
<thead>
  <tr>
    <th>
      run
    </th>
    
    <th>
      <code>
        previousFailures
      </code>
    </th>
    
    <th>
      <code>
        onStreak: 3
      </code>
      
       → alert
    </th>
  </tr>
</thead>

<tbody>
  <tr>
    <td>
      1st failure
    </td>
    
    <td>
      0
    </td>
    
    <td>
      silent (1 ≠ 3)
    </td>
  </tr>
  
  <tr>
    <td>
      2nd failure
    </td>
    
    <td>
      1
    </td>
    
    <td>
      silent
    </td>
  </tr>
  
  <tr>
    <td>
      3rd failure
    </td>
    
    <td>
      2
    </td>
    
    <td>
      <code>
        run.failed
      </code>
      
       + <code>
        consecutiveFailures: 3
      </code>
    </td>
  </tr>
  
  <tr>
    <td>
      4th failure
    </td>
    
    <td>
      3
    </td>
    
    <td>
      silent — one alert per streak, no reminders
    </td>
  </tr>
  
  <tr>
    <td>
      success
    </td>
    
    <td>
      3
    </td>
    
    <td>
      <code>
        run.succeeded
      </code>
      
       + <code>
        previousFailures: 3
      </code>
      
       («отпустило»)
    </td>
  </tr>
  
  <tr>
    <td>
      next failure
    </td>
    
    <td>
      0
    </td>
    
    <td>
      a fresh incident alerts again
    </td>
  </tr>
</tbody>
</table>

The counter lives in the engine process, not in storage: the storage
`failCount` is *cumulative* (never reset by a success), and a persisted
consecutive-counter would be a `Storage`-contract change. A daemon restart
forgets an in-flight streak — the next failure alerts once more rather than
staying silent (no alert is ever lost).

`createAlerts` (webhook) is a ready-made `onRunFinal` consumer — wire it as
`onRunFinal: createAlerts(config).handleFinal` and
`onEvent: createAlerts(config).handleEvent` (daemon: the `alerts` option; see
[Self-hosting → Status alerts](self-hosting#status-alerts)).

## 3. Engine events — claim / dispatch / retry / zombie reap

The engine core stays silent by default, but ships a native event stream via
`onEvent` — a typed union of lifecycle events, one per claim, dispatch, run
outcome, retry schedule, poll and zombie reap. This is the supported way to
watch *why* a task fired (or didn't):

```ts
import { createEngine, createEventLogger } from '@schedjs/core';

const engine = createEngine({
  storage,
  runner,
  onEvent: createEventLogger(), // ready-made console formatter
});
```

The events (all carry `taskName` / `runId` / `attempt` where relevant):

<table>
<thead>
  <tr>
    <th>
      Event
    </th>
    
    <th>
      When
    </th>
    
    <th>
      Extra fields
    </th>
  </tr>
</thead>

<tbody>
  <tr>
    <td>
      <code>
        tick
      </code>
    </td>
    
    <td>
      a scan found due tasks (never a 0-due tick)
    </td>
    
    <td>
      <code>
        dueCount
      </code>
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        claim
      </code>
    </td>
    
    <td>
      a task lock was taken
    </td>
    
    <td>
      —
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        dispatch
      </code>
    </td>
    
    <td>
      the runner was invoked
    </td>
    
    <td>
      <code>
        runner
      </code>
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        run-succeeded
      </code>
      
       / <code>
        run-failed
      </code>
      
       / <code>
        run-cancelled
      </code>
    </td>
    
    <td>
      per-attempt terminal outcome
    </td>
    
    <td>
      <code>
        error
      </code>
      
       (fail/cancel)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        retry-scheduled
      </code>
    </td>
    
    <td>
      a failure still has retries left
    </td>
    
    <td>
      <code>
        nextRunAt
      </code>
      
      , <code>
        backoffMs
      </code>
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        missed-slot
      </code>
    </td>
    
    <td>
      a schedule dispatched later than the grace window (downtime catch-up / wedged lock)
    </td>
    
    <td>
      <code>
        scheduledAt
      </code>
      
      , <code>
        delayMs
      </code>
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        poll
      </code>
    </td>
    
    <td>
      an async run was polled
    </td>
    
    <td>
      <code>
        status
      </code>
      
      , <code>
        progress
      </code>
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        cancel-sent
      </code>
      
       / <code>
        cancel-ack
      </code>
      
       / <code>
        cancel-failed
      </code>
      
       / <code>
        cancel-no-channel
      </code>
    </td>
    
    <td>
      an async cancel signal was POSTed to the worker's <code>
        cancelUrl
      </code>
      
      , acked with a status, failed with a reason, or skipped (no <code>
        cancelUrl
      </code>
      
       — legacy stop-polling)
    </td>
    
    <td>
      <code>
        cancelUrl
      </code>
      
       (sent), <code>
        status
      </code>
      
       (ack), <code>
        error
      </code>
      
       (failed)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        zombie-reaped
      </code>
    </td>
    
    <td>
      stale locks were released (only when > 0)
    </td>
    
    <td>
      <code>
        count
      </code>
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        recovered-orphans
      </code>
    </td>
    
    <td>
      startup recovery cancelled orphaned in-flight runs
    </td>
    
    <td>
      <code>
        count
      </code>
      
      , <code>
        clearedLocks
      </code>
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        error
      </code>
    </td>
    
    <td>
      a storage/runner failure was caught by the tick boundary
    </td>
    
    <td>
      <code>
        message
      </code>
    </td>
  </tr>
</tbody>
</table>

The four `cancel-*` events are the async-cancel channel's observability contract
(battle-stand debugging, 2026-08-21) — one line per cancel attempt, so the
operator can tell **«signal never sent»** (`cancel-no-channel`) from
**«sent and failed»** (`cancel-failed`) from **«acked»** (`cancel-ack`). The
daemon writes them to stdout as `[cancel] POST <url> runId=<id>` / `[cancel] ack status=<n>` / `[cancel] failed: <причина>` / `[cancel] no cancelUrl — legacy stop-polling` — grep `[cancel]` in `docker logs` to follow a cancel attempt.

```ts
const engine = createEngine({
  // ...
  onEvent: (e) => {
    if (e.type === 'run-failed') console.error(`[sched] ${e.taskName} attempt ${e.attempt}: ${e.error}`);
    if (e.type === 'retry-scheduled') console.warn(`[sched] retry ${e.taskName} in ${e.backoffMs}ms`);
  },
});
```

Semantics worth knowing:

- **Retries.** A failed attempt always emits `run-failed`; if a retry is still
planned it is *also* followed by `retry-scheduled` (the backoff plan). The
final, exhausted failure emits only `run-failed` — the persistent-fail alert
lands via `onRunFinal` (see section 2).
- **Noise guards.** `tick` fires only when something is due; `zombie-reaped`
only when locks were actually reaped — at 1s/60s cadence a "0 due" line would
drown the signal.
- **Manual triggers.** `triggerTask` emits `dispatch` + the outcome (no `claim`
— nothing was claimed) and never a `retry-scheduled`.
- **Observer safety.** A throwing `onEvent` is swallowed — a logging bug must
never take the scheduler down.

`createEventLogger` formats the stream into single-line `[sched] …` entries
(console by default; point `write` at pino for structured output, or use
`filter` to keep only the event types you care about):

```text
[sched] tick: 3 due
[sched] claim publish-video run=ab12cd34 attempt=1
[sched] dispatch publish-video run=ab12cd34 runner=http attempt=1
[sched] retry publish-video run=ab12cd34 attempt=1 backoff=60000ms (next 2026-08-16 12:01:00Z)
[sched] missed-slot publish-video sched=publish-video scheduled 2026-08-16 03:00:00Z (32400000ms late)
[sched] reaped 2 zombie lock(s) older than 2026-08-16 11:30:00Z
```

### Still possible: wrapping the Storage seam

The engine's storage calls remain a valid, lower-level observation point —
every engine action (due scan, claim, completion, zombie reap) is a `Storage`
method call, so a proxy logs the lifecycle at a coarser granularity (e.g. to
capture *skipped* claims, which the event stream intentionally leaves silent):

```ts
import type { Storage } from '@schedjs/core';

function loggingStorage(s: Storage): Storage {
  return {
    ...s,
    async listDueTasks(now) {
      const due = await s.listDueTasks(now);
      console.log(`[sched] tick: ${due.length} due`);
      return due;
    },
    async claimTask(name, at) {
      const ok = await s.claimTask(name, at);
      console.log(`[sched] claim ${name} → ${ok ? 'taken' : 'skipped (locked/paused)'}`);
      return ok;
    },
    async completeTask(name, result) {
      await s.completeTask(name, result);
      console.log(`[sched] done ${name} failed=${result.failed} next=${result.nextRunAt?.toISOString()}`);
    },
    async reapZombieLocks(olderThan) {
      const n = await s.reapZombieLocks(olderThan);
      if (n > 0) console.log(`[sched] reaped ${n} zombie lock(s)`);
      return n;
    },
  };
}

// pass the wrapper to the engine:
createEngine({ storage: loggingStorage(createSqliteStorage(db)), /* ... */ });
```

## What's not logged yet

- **Claim skips** (a due task that lost the claim race to another replica) are
silent in the event stream — see the Storage-proxy recipe above.
- **0-due ticks** are silent by design (cadence noise) — `tick` fires only when
a scan found due tasks.
- **Run output** (stdout/stderr) is not streamed live — read the stored `log`
field of the `RunRecord` (section 1).
