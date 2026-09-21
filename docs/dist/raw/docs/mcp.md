# MCP server

> Product MCP — AI control plane over the admin API (list/get tasks & runs, trigger/pause/resume, delete)

`@schedjs/mcp` exposes sched's control plane as a [Model Context Protocol](https://modelcontextprotocol.org) server.
An AI client (Claude Desktop, codex, pi, Cursor) can inspect and drive a running daemon — list tasks, read
run history, trigger runs, pause/resume — from natural language, with the same guarantees as the admin API.

The MCP server is a **projection of the admin API**: it never opens storage itself, it calls the daemon's
REST API with the same bearer key. The daemon stays the single owner of state.

> Docs MCP (search over these docs) is a separate, built-in server: Docus serves `/mcp` on the docs site
> (list-pages + read-page). This page is about the **product** MCP for managing sched.

## Install

```text
yarn workspace @schedjs/mcp build
```

## Run (stdio)

Default transport for local AI clients:

```text
sched-mcp --admin-url http://127.0.0.1:8080 --api-key <SCHED_ADMIN_KEY>
```

Point your client at `npx sched-mcp` (or the built `dist/cli.js`) with the same arguments.

## Run (Streamable HTTP)

For remote/daemon-side hosting:

```text
sched-mcp --http 8091 --admin-url http://127.0.0.1:8080 --api-key <SCHED_ADMIN_KEY>
```

The HTTP mode is **session-based** (stateful Streamable HTTP): each client gets its own MCP
session — a `Mcp-Session-Id` header is issued on `initialize` and must be echoed on later
requests. Sessions are removed when the client sends `DELETE`, and are garbage-collected
after 30 min of inactivity, so a long-running server neither leaks transports nor clashes
on a shared connection. Unknown session ids are rejected with `404`.

## Options

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
      Meaning
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
        http://127.0.0.1:8080
      </code>
    </td>
    
    <td>
      Admin API base URL
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
      Admin API bearer key (open in dev mode if unset)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        --http PORT
      </code>
    </td>
    
    <td>
      —
    </td>
    
    <td>
      stdio
    </td>
    
    <td>
      Serve Streamable HTTP on PORT
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        --readonly
      </code>
    </td>
    
    <td>
      —
    </td>
    
    <td>
      off
    </td>
    
    <td>
      Reject mutations; only list/get tools respond
    </td>
  </tr>
</tbody>
</table>

## Tools

<table>
<thead>
  <tr>
    <th>
      Tool
    </th>
    
    <th>
      Args
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
        list_tasks
      </code>
    </td>
    
    <td>
      —
    </td>
    
    <td>
      All tasks: name, runner, schedule, paused, next run
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        get_task
      </code>
    </td>
    
    <td>
      <code>
        name
      </code>
    </td>
    
    <td>
      One task, full config
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        list_schedules
      </code>
    </td>
    
    <td>
      —
    </td>
    
    <td>
      Schedules: taskName, schedule (cron/interval/once), tz, nextRunAt, lastRunAt, paused, effectiveStatus
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        get_schedule
      </code>
    </td>
    
    <td>
      <code>
        scheduleId
      </code>
    </td>
    
    <td>
      One schedule: rule, tz, data, effectiveStatus
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        create_schedule
      </code>
    </td>
    
    <td>
      <code>
        taskName schedule tz?
      </code>
    </td>
    
    <td>
      Create (or upsert by <code>
        dedupKey
      </code>
      
      ) a schedule (mutation); <code>
        data
      </code>
      
       validated against the task <code>
        inputSchema
      </code>
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        update_schedule
      </code>
    </td>
    
    <td>
      <code>
        scheduleId schedule? tz?
      </code>
    </td>
    
    <td>
      Edit a schedule in place (mutation, partial merge)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        pause_schedule
      </code>
    </td>
    
    <td>
      <code>
        scheduleId
      </code>
    </td>
    
    <td>
      Pause one schedule instance (mutation)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        resume_schedule
      </code>
    </td>
    
    <td>
      <code>
        scheduleId
      </code>
    </td>
    
    <td>
      Resume a paused schedule (mutation)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        delete_schedule
      </code>
    </td>
    
    <td>
      <code>
        scheduleId
      </code>
    </td>
    
    <td>
      Delete a schedule; runs keep history (mutation)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        list_runs
      </code>
    </td>
    
    <td>
      <code>
        task? status? since? until? runner? limit? offset?
      </code>
    </td>
    
    <td>
      Runs, newest first; filter by task/status/runner and the <code>
        startedAt
      </code>
      
       window (<code>
        since
      </code>
      
      /<code>
        until
      </code>
      
      , ISO-8601, inclusive)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        get_run
      </code>
    </td>
    
    <td>
      <code>
        runId
      </code>
    </td>
    
    <td>
      One run: status, error, log, result, artifacts
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        trigger_task
      </code>
    </td>
    
    <td>
      <code>
        name data?
      </code>
    </td>
    
    <td>
      Run a task immediately (mutation); <code>
        data
      </code>
      
       validated against the task <code>
        inputSchema
      </code>
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        cancel_run
      </code>
    </td>
    
    <td>
      <code>
        runId
      </code>
    </td>
    
    <td>
      Cancel a running/queued run (mutation); a terminal run → 409
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        retry_run
      </code>
    </td>
    
    <td>
      <code>
        runId triggeredBy?
      </code>
    </td>
    
    <td>
      Re-execute a finished run with its original data (mutation)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        pause_task
      </code>
    </td>
    
    <td>
      <code>
        name
      </code>
    </td>
    
    <td>
      Stop scheduling a task (mutation)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        resume_task
      </code>
    </td>
    
    <td>
      <code>
        name
      </code>
    </td>
    
    <td>
      Resume a paused task (mutation)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        pause_queue
      </code>
    </td>
    
    <td>
      —
    </td>
    
    <td>
      Pause the whole queue (mutation, idempotent): recurring schedules skip the window, <code>
        once
      </code>
      
      /retries are deferred
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        resume_queue
      </code>
    </td>
    
    <td>
      —
    </td>
    
    <td>
      Resume a paused queue (mutation, idempotent); deferred runs play out once
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        delete_task
      </code>
    </td>
    
    <td>
      <code>
        name
      </code>
    </td>
    
    <td>
      Delete a task; runs keep history (mutation)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        delete_run
      </code>
    </td>
    
    <td>
      <code>
        runId
      </code>
    </td>
    
    <td>
      Delete a run from history (mutation)
    </td>
  </tr>
</tbody>
</table>

`pause_queue`/`resume_queue` are **mutations** — gated by `--readonly` like the
rest. There are deliberately **no bulk run tools**: a batch cancel/retry is an
operator action (CLI `sched cancel <id...>` / admin API); an agent makes an
explicit loop of `cancel_run`/`retry_run` calls.

Mutations (`trigger_task`, `pause_task`, `resume_task`, `pause_queue`, `resume_queue`, `delete_run`, `cancel_run`, `retry_run`, `delete_task`, `create_schedule`, `update_schedule`, `pause_schedule`, `resume_schedule`, `delete_schedule`) are disabled in `--readonly` mode.

## Safety model

- **Server-side validation** — schedules/statuses are validated by the admin API; unknown tasks/runs
return a clear error, never a crash.
- **Read-only mode** — hard gate for automation: mutations answer with an explicit error.
- **Human approval** — the MCP server does not invent a confirm protocol; the confirm gate lives in
the AI-client layer: the AI proposes, a human approves, the AI calls the mutation tool.
