# Comparison

> sched next to the Node.js job schedulers and queues it is usually weighed against — BullMQ (and its commercial BullMQ-Pro), Bull, Kue, Bee, pg-boss and Agenda

This page puts sched next to the job schedulers and queues it is normally weighed
against in the Node ecosystem: **BullMQ** — plus its commercial tier **BullMQ-Pro** —
**Bull**, **Kue**, **Bee**, **pg-boss** and **Agenda**.

A note on honesty before the table: our own column is written from sched's own code and
docs. The columns for the other projects are taken from two published comparison charts —
[Agenda's](https://github.com/agenda/agenda#feature-comparison) (which credits the
[Bull](https://www.npmjs.com/package/bull#feature-comparison) maintainers for the original)
and [BullMQ's](https://github.com/taskforcesh/bullmq#feature-comparison) — plus package
metadata from npm, all checked on **2026-09-19**. Where a chart was silent, the cell is
left empty rather than guessed: an empty cell means *unknown / not claimed*, not *no*.

## Backends, status and license

<table>
<thead>
  <tr>
    <th>
      
    </th>
    
    <th>
      <strong>
        sched
      </strong>
    </th>
    
    <th>
      BullMQ-Pro
    </th>
    
    <th>
      BullMQ
    </th>
    
    <th>
      Bull
    </th>
    
    <th>
      Kue
    </th>
    
    <th>
      Bee
    </th>
    
    <th>
      pg-boss
    </th>
    
    <th>
      Agenda
    </th>
  </tr>
</thead>

<tbody>
  <tr>
    <td>
      Backend
    </td>
    
    <td>
      SQLite, MySQL/MariaDB, Postgres, Mongo
    </td>
    
    <td>
      redis
    </td>
    
    <td>
      redis
    </td>
    
    <td>
      redis
    </td>
    
    <td>
      redis
    </td>
    
    <td>
      redis
    </td>
    
    <td>
      postgres
    </td>
    
    <td>
      mongo, postgres, redis
    </td>
  </tr>
  
  <tr>
    <td>
      Last release
    </td>
    
    <td>
      active
    </td>
    
    <td>
      active
    </td>
    
    <td>
      2026-09-18
    </td>
    
    <td>
      2024-12-18
    </td>
    
    <td>
      2024-11-04
    </td>
    
    <td>
      2025-12-08
    </td>
    
    <td>
      2026-09-18
    </td>
    
    <td>
      2026-07-21
    </td>
  </tr>
  
  <tr>
    <td>
      Optimized for
    </td>
    
    <td>
      Jobs
    </td>
    
    <td>
      Jobs / Messages
    </td>
    
    <td>
      Jobs / Messages
    </td>
    
    <td>
      Jobs / Messages
    </td>
    
    <td>
      Jobs
    </td>
    
    <td>
      Messages
    </td>
    
    <td>
      Jobs
    </td>
    
    <td>
      Jobs
    </td>
  </tr>
  
  <tr>
    <td>
      License
    </td>
    
    <td>
      MIT
    </td>
    
    <td>
      commercial
    </td>
    
    <td>
      MIT
    </td>
    
    <td>
      MIT
    </td>
    
    <td>
      MIT
    </td>
    
    <td>
      MIT
    </td>
    
    <td>
      MIT (one maintainer)
    </td>
    
    <td>
      MIT
    </td>
  </tr>
</tbody>
</table>

Status read: **BullMQ**, **pg-boss** and **Agenda** are the living ones alongside sched.
**Bull** and **Kue** have not shipped since 2024, **Bee** since late 2025 — treat those
three as legacy.

## Features

Rows in the first block come from the two charts above; the second block holds the
capabilities we could not fill from a published chart, so only sched's column is filled
there.

<table>
<thead>
  <tr>
    <th>
      
    </th>
    
    <th>
      <strong>
        sched
      </strong>
    </th>
    
    <th>
      BullMQ-Pro
    </th>
    
    <th>
      BullMQ
    </th>
    
    <th>
      Bull
    </th>
    
    <th>
      Kue
    </th>
    
    <th>
      Bee
    </th>
    
    <th>
      pg-boss
    </th>
    
    <th>
      Agenda
    </th>
  </tr>
</thead>

<tbody>
  <tr>
    <td>
      TypeScript
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
  </tr>
  
  <tr>
    <td>
      Priorities
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
  </tr>
  
  <tr>
    <td>
      Concurrency
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
  </tr>
  
  <tr>
    <td>
      Delayed jobs
    </td>
    
    <td>
      ✓¹
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
  </tr>
  
  <tr>
    <td>
      Global events
    </td>
    
    <td>
      
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
  </tr>
  
  <tr>
    <td>
      Rate limiter
    </td>
    
    <td>
      
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
  </tr>
  
  <tr>
    <td>
      Deduplication (debouncing)
    </td>
    
    <td>
      
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
  </tr>
  
  <tr>
    <td>
      Pause / resume
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      ✓
    </td>
  </tr>
  
  <tr>
    <td>
      Sandboxed worker
    </td>
    
    <td>
      
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
  </tr>
  
  <tr>
    <td>
      Repeatable jobs (cron)
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
  </tr>
  
  <tr>
    <td>
      Auto-retry with backoff
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
  </tr>
  
  <tr>
    <td>
      Dead letter queue
    </td>
    
    <td>
      
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
  </tr>
  
  <tr>
    <td>
      Parent/child dependencies
    </td>
    
    <td>
      
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
  </tr>
  
  <tr>
    <td>
      Atomic ops
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ~
    </td>
  </tr>
  
  <tr>
    <td>
      Persistence
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
  </tr>
  
  <tr>
    <td>
      UI
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      ✓
    </td>
  </tr>
  
  <tr>
    <td>
      REST API
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      ✓
    </td>
  </tr>
  
  <tr>
    <td>
      Central (scalable) queue
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      ✓
    </td>
  </tr>
  
  <tr>
    <td>
      Optimized for long-running jobs
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      ✓
    </td>
  </tr>
  
  <tr>
    <td>
      Human-readable intervals
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      ✓
    </td>
  </tr>
  
  <tr>
    <td>
      Cron with a timezone, DST-safe
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
  </tr>
  
  <tr>
    <td>
      Run history: progress, log, artifacts
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
  </tr>
  
  <tr>
    <td>
      Run history window (<code>
        since
      </code>
      
       / <code>
        until
      </code>
      
       / <code>
        runner
      </code>
      
      )
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
  </tr>
  
  <tr>
    <td>
      Cancel a <em>
        running
      </em>
      
       job
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
  </tr>
  
  <tr>
    <td>
      Bulk cancel / retry (many runs in one call)
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
  </tr>
  
  <tr>
    <td>
      Run deadline (<code>
        timeoutMs
      </code>
      
      )
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
  </tr>
  
  <tr>
    <td>
      Many schedules per task
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
  </tr>
  
  <tr>
    <td>
      Polyglot workers (HTTP / Docker / SSH / process)
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
  </tr>
  
  <tr>
    <td>
      MCP: control plane <strong>
        and
      </strong>
      
       MCP server as a worker
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
  </tr>
  
  <tr>
    <td>
      Tool allowlist sandbox (<code>
        allowedTools
      </code>
      
      )
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
  </tr>
  
  <tr>
    <td>
      Alerts on a missed slot / final run
    </td>
    
    <td>
      ✓
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
    
    <td>
      
    </td>
  </tr>
</tbody>
</table>

¹ **Delayed jobs, sched's flavour.** A delay is expressed as a **one-shot schedule**, not as
a property of an enqueued job: `{ "once": "tomorrow at noon" }` in `tasks.json`, or
`POST /schedules` at runtime — a real schedule entity carrying `data`, `tz` and `dedupKey`,
which fires once and then unschedules. What sched does *not* have is BullMQ's per-job
`delay(ms)` on an immediate trigger: `POST /tasks/:name/run` starts the run now.

² **"Sandboxed worker" means something else here, so sched's cell is empty.** In BullMQ
and Bull it is process isolation — the job runs in a separate child process. sched has no
such isolation; its sandbox is a *policy*: each run is checked against
[`allowedTools`](security) (an allowlist of commands, images or MCP `server:tool` specs)
before it is allowed to spawn. That is why the allowlist appears as its own row.

## What the table does not say

- **Schedulers versus queues.** sched and Agenda are cron schedulers with a job queue
attached. BullMQ, Bull and Bee are queues that also happen to support repeatable jobs.
If your unit of work is "a message that must be consumed fast and exactly once", that is
their home ground, not ours.
- **The paid line.** BullMQ-Pro's ticks are commercial features of that package. The UI
rows are also not always in the box: Agenda's UI is the separate
[Agendash](https://github.com/agenda/agenda/tree/main/packages/agendash) package, and
BullMQ's open-source dashboard is the separate Bull Board project.
- **Blanks are blanks.** An empty cell above means the source chart did not claim the
feature and we did not test it — not that the feature is missing.
- **No benchmarks.** Nothing on this page is a throughput or latency claim. Compare those
on your own workload.

## When to pick something else

- **High-throughput queue with rate limiting, retries and a worker fleet in Redis** →
**BullMQ**.
- **Already on Postgres and you want queues in the same database** → **pg-boss**.
- **On MongoDB, want minimal overhead, and the chart above fits you** → **Agenda**.
- **On Bull, Kue or Bee** → they have not shipped since 2024/2025; plan a migration to
whichever of the living options fits.
- **You need durable multi-step workflows** (steps, long sleeps, signals) → that is a
different class of tool entirely.

## Sources

- Agenda's feature comparison chart — [https://github.com/agenda/agenda#feature-comparison](https://github.com/agenda/agenda#feature-comparison)
- BullMQ's feature comparison chart — [https://github.com/taskforcesh/bullmq#feature-comparison](https://github.com/taskforcesh/bullmq#feature-comparison)
- pg-boss README (cron/RRULE, maintenance model) — [https://github.com/timgit/pg-boss](https://github.com/timgit/pg-boss)
- Release dates and licenses — npm registry metadata for `bullmq`, `bull`, `kue`,
`bee-queue`, `pg-boss`, `agenda`, checked 2026-09-19.
