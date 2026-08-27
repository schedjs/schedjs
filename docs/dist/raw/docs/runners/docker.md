# Docker runner

> Run tasks in containers

The Docker runner spawns a container per run via the `docker` CLI (`docker run --rm`),
captures output, and maps the exit code to the run status.

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
        image
      </code>
    </td>
    
    <td>
      string
    </td>
    
    <td>
      —
    </td>
    
    <td>
      <strong>
        Required.
      </strong>
      
       Image name (may include a tag: <code>
        alpine:3.20
      </code>
      
      )
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        tag
      </code>
    </td>
    
    <td>
      string
    </td>
    
    <td>
      image tag
    </td>
    
    <td>
      Explicit tag (<code>
        alpine
      </code>
      
       + <code>
        tag: "3.20"
      </code>
      
       → <code>
        alpine:3.20
      </code>
      
      )
    </td>
  </tr>
  
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
      Override the container command: <code>
        command[0]
      </code>
      
       → <code>
        --entrypoint
      </code>
      
      , <code>
        command[1..]
      </code>
      
       → argv after the image
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
      Extra arguments
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
      
      . <code>
        -1
      </code>
      
       = <strong>
        no timeout
      </strong>
      
       — the container runs until it exits or is cancelled by the operator (matching the task-level run-deadline semantics)
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
      Sandbox: images/commands this task may run (<code>
        image@command
      </code>
      
       specs) — see <a href="../security">
        Security
      </a>
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
      <strong>
        Experimental.
      </strong>
      
       Stdio contract — see below
    </td>
  </tr>
</tbody>
</table>

## Environment

Every container gets:

- `SCHED_RUN_ID` — the run id
- `SCHED_TASK_NAME` — the task name
- `data` → each top-level key as `SCREAMING_SNAKE` env var (`{ "userId": 42 }` →
`USER_ID=42`) plus `SCHED_DATA` with the full JSON. Static `env` wins over data-derived vars.
Two data keys that map to the same env var (`fooBar` and `foo_bar` → `FOO_BAR`) are an error:
config validation fails fast at load time, and a run that slips through fails instead of
silently last-write-wins.

## Exit codes

<table>
<thead>
  <tr>
    <th>
      Exit
    </th>
    
    <th>
      Result
    </th>
  </tr>
</thead>

<tbody>
  <tr>
    <td>
      <code>
        0
      </code>
    </td>
    
    <td>
      <code>
        succeeded
      </code>
    </td>
  </tr>
  
  <tr>
    <td>
      non-zero
    </td>
    
    <td>
      <code>
        failed
      </code>
      
       with <code>
        exit N
      </code>
      
       + tail of the log
    </td>
  </tr>
  
  <tr>
    <td>
      timeout
    </td>
    
    <td>
      SIGTERM → SIGKILL → <code>
        cancelled
      </code>
    </td>
  </tr>
</tbody>
</table>

`config.timeoutMs: -1` disables the container timeout entirely — the process
runs until it exits on its own or is cancelled manually. (Before daemon 0.11.0 a
`-1` was passed straight into `setTimeout` and killed the container instantly
with `timeout after -1ms`.)

## Stdio contract (`envelope: true`) — experimental

> **Experimental.** The [process runner](process) ships a reference worker for the
> stdio contract; a container image that speaks it is not published yet. Enable it
> when your own image implements the contract (see below) — exit-code mode remains
> the default and is unchanged.

Opt-in protocol mode for containers that want to report progress and results
structurally. The container speaks the [stdio transport](../protocol#stdio-transport):

- **request** — one JSON envelope `{ "task": { "name", "config" }, "data" }` on
**stdin** (`docker run -i`, attached automatically), then EOF
- **progress** — NDJSON lines on **stdout**: intermediate
`{ "status": "running", "progress": 42 }`
- **result** — one terminal line on **stdout** (same envelope shape as the process
runner / HTTP runner)
- **logs** — anything else on **stderr** (never stdout — stdout is the protocol)

```json
{ "runner": "docker", "config": { "image": "registry/my-worker", "envelope": true, "data": { "videoId": "v-42" } } }
```

A container that opted in but exits without a terminal envelope is a broken worker: the
run fails with a clear protocol error. A container without `envelope` keeps the plain
exit-code mapping — the two modes never mix.

## Private registries (auth)

The runner spawns the **docker CLI** (`docker run --rm`), not the docker HTTP API — so
CLI credential resolution applies. `docker run` pulls an image that is not present
locally, and that implicit pull authenticates exactly like `docker pull`:

- **The CLI must exist in the daemon's image.** The official `sched-daemon` image
ships `docker-cli` (added 2026-08-22 after books' T2 finding); a custom/composed
image that drops it needs `apk add docker-cli` (alpine) — otherwise every
docker task fails with `ENOENT` at spawn.
- `$DOCKER_CONFIG/config.json` (default `~/.docker/config.json`) — mount it into the
daemon's container (`/root/.docker/config.json`) or point `DOCKER_CONFIG` at a volume.
- The same file that `docker login` writes — no sched-side config, no env creds.
- Works unchanged behind a read-only docker-socket proxy (`DOCKER_HOST`): credentials
are a CLI-side concern, the proxy passes the pull through.

The image allowlist is matched **by name/command string only** (`image[@command]`);
registry auth never affects allowlist matching or tag resolution (default `:latest`,
explicit `tag` wins — pure string logic). The actual tag dereference happens at pull
time inside the docker daemon, which is exactly where the credentials apply. A pull
that fails auth surfaces as a run failure (`docker run` exits non-zero with the
registry's 401 in the log).

## Security: sandbox (`allowedTools`)

The runner is constrained by the sandbox ceiling — pass `allowedTools` when
creating the runner (or set it in the daemon build / tasks.json `runners` block,
see [Security](../security)). Exact names and trailing wildcards are supported:
`allowedTools: ['alpine:*', 'ghcr.io/my-org/*']`. A task whose image/command is
not allowed fails fast **before** any container is spawned.

A ceiling spec with a command dimension (`alpine@echo`) also blocks tasks that
omit an explicit command (the image's default entrypoint) — to allow the image
default, use `alpine` (no `@`).

```ts
import { createDaemon } from '@schedjs/daemon';
import { createDockerRunner } from '@schedjs/core';

const daemon = createDaemon({
  dbPath: 'sched.db',
  tasksPath: 'tasks.json',
  runners: {
    docker: createDockerRunner({ allowedTools: ['alpine:*', 'busybox:*'] }),
  },
});
```

## Production note

Never expose a raw docker socket to the network. On a host, route the daemon through a
read-only docker-socket proxy (e.g. tecnativa with `POST=0`) and keep the allowlist on —
see [Self-hosting](../self-hosting).
