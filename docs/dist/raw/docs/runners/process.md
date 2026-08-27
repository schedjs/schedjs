# Process runner

> Run local commands as tasks

The process runner executes a local command per run — no Docker, no HTTP. It is the
lightweight sibling of the [Docker runner](docker): same exit-code mapping, same
environment contract, but the command runs directly on the daemon host.

## Config

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
        command
      </code>
    </td>
    
    <td>
      string<span>
        
      </span>
    </td>
    
    <td>
      —
    </td>
    
    <td>
      <strong>
        Required.
      </strong>
      
       The full argv, no shell: <code>
        command[0]
      </code>
      
       is the executable (<code>
        node
      </code>
      
      , <code>
        python3
      </code>
      
      , <code>
        powershell
      </code>
      
      )
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        args
      </code>
    </td>
    
    <td>
      string<span>
        
      </span>
    </td>
    
    <td>
      —
    </td>
    
    <td>
      Extra argv appended after <code>
        command
      </code>
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        env
      </code>
    </td>
    
    <td>
      object
    </td>
    
    <td>
      —
    </td>
    
    <td>
      Static env vars (win over <code>
        data
      </code>
      
      -derived vars)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        data
      </code>
    </td>
    
    <td>
      unknown
    </td>
    
    <td>
      —
    </td>
    
    <td>
      Run parameters → <code>
        SCREAMING_SNAKE
      </code>
      
       env vars + <code>
        SCHED_DATA
      </code>
      
       (JSON)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        envelope
      </code>
    </td>
    
    <td>
      boolean
    </td>
    
    <td>
      false
    </td>
    
    <td>
      Stdio contract — see below
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        cwd
      </code>
    </td>
    
    <td>
      string
    </td>
    
    <td>
      daemon cwd
    </td>
    
    <td>
      Working directory for the command
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
      300000 (5 min)
    </td>
    
    <td>
      Timeout: SIGTERM → 10s grace → SIGKILL → <code>
        cancelled
      </code>
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        maxLogKb
      </code>
    </td>
    
    <td>
      number
    </td>
    
    <td>
      10
    </td>
    
    <td>
      Ring-buffer log cap
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        allowedTools
      </code>
    </td>
    
    <td>
      string<span>
        
      </span>
    </td>
    
    <td>
      —
    </td>
    
    <td>
      Sandbox: executables this task may run — see <a href="../security">
        Security
      </a>
    </td>
  </tr>
</tbody>
</table>

## No shell, by design

`command` is an explicit argv, never a shell string. Shell features (globs, pipes,
redirects) are not available — the interpreter is explicit:

```json
{ "runner": "process", "config": { "command": ["node", "/opt/scripts/report.mjs"] } }
{ "runner": "process", "config": { "command": ["powershell", "-File", "C:\\ops\\check.ps1"] } }
```

There is no injection surface beyond what the operator writes in `tasks.json`.

## Environment

Identical to the Docker runner — **the child's environment is replaced, not
inherited**: the daemon's ambient `process.env` (PATH, HOME, …) is NOT passed
down. The child sees only the items below. Isolated on purpose (docker-parity: the
worker never sees the daemon's secrets).

- `SCHED_RUN_ID` — the run id
- `SCHED_TASK_NAME` — the task name
- `data` → each top-level key as `SCREAMING_SNAKE` env var (`{ "userId": 42 }` →
`USER_ID=42`) plus `SCHED_DATA` with the full JSON. Static `env` wins over data-derived vars.
Two data keys that map to the same env var (`fooBar` and `foo_bar` → `FOO_BAR`) are an
error: the run fails fast instead of silently overwriting.

## Exit-code mapping (default)

- `0` → `succeeded` (log attached)
- `!=0` → `failed` `exit N: <tail>`
- timeout → killed (SIGTERM, SIGKILL after grace) → `cancelled`
- spawn error (executable missing) → `failed`

## Stdio contract (`envelope: true`)

Opt-in protocol mode for workers that want to report progress and results
structurally. The worker speaks the [stdio transport](../protocol#stdio-transport):

- **request** — one JSON envelope `{ "task": { "name", "config" }, "data" }` on **stdin**
(then EOF)
- **progress** — NDJSON lines on **stdout**: intermediate
`{ "status": "running", "progress": 42 }`
- **result** — one terminal line on **stdout**:
`{ "status": "succeeded"|"failed"|"cancelled", "result", "error", "progress", "log", "artifacts" }`
- **logs** — anything else on **stderr** (never stdout — stdout is the protocol channel)

A worker that opted in but exits without a terminal envelope is a broken worker: the run
fails with a clear protocol error, never silently passes.

Reference implementation: `examples/stdio-worker.mjs` (in the repo's `examples/workers/`).

```json
{
  "tasks": [
    {
      "name": "export-captions",
      "schedules": [{ "cron": "0 9 * * *" }],
      "runner": "process",
      "config": {
        "command": ["node", "/opt/workers/captions.mjs"],
        "envelope": true,
        "data": { "videoId": "v-42", "language": "en" }
      }
    }
  ]
}
```

## Security: sandbox (`allowedTools`)

Like the Docker runner's `allowedTools`, the process runner gates commands —
see [Security](../security) for the full model (per-task + ceiling):

```ts
createProcessRunner({
  allowedTools: ['node', 'python3', 'powershell*'], // exact or trailing-*
});
```

A task whose `command[0]` is outside the allowlist fails at load time
(`validateConfig`) — before any run — and never spawns at dispatch.
