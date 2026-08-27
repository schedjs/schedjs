# MCP runner

> Call a tool on an MCP server (stdio or Streamable HTTP)

The MCP runner calls a tool on a [Model Context Protocol](https://modelcontextprotocol.org)
server per run — sync-only: the run resolves when the tool call resolves. This is the
inverse of the [product MCP server](../mcp): there sched *exposes* its control plane to
agents; here a task *consumes* any MCP server (an agent, a web service, a local tool
server) as its worker.

## When to use it

Prefer the [HTTP runner](http) whenever the tool is reachable over plain HTTP — a
cron calling a REST endpoint needs no MCP ceremony at all. The MCP runner earns
its place only when:

- the tool exists **only** as an MCP tool (no REST wrapper), **and**
- you need a deterministic schedule→tool call **without an agent/LLM in the loop**
(the runner does the JSON-RPC ceremony: initialize/session/tools/call, maps
`isError` → `failed`, text blocks → `succeeded`).

`stdio` transport spawns the server cold per run (`npx …`) with no persistent
connection — prefer `http` (Streamable HTTP) for anything you call on a schedule.
If a scheduled MCP tool hasn't been needed in months, that's a sign it belongs on
the http runner instead.

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
        server
      </code>
    </td>
    
    <td>
      object
    </td>
    
    <td>
      —
    </td>
    
    <td>
      <strong>
        Required.
      </strong>
      
       The MCP server to connect to — see below
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        tool
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
      
       The tool to call
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        args
      </code>
    </td>
    
    <td>
      object
    </td>
    
    <td>
      —
    </td>
    
    <td>
      Static arguments forwarded to the tool call
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
      Call timeout → <code>
        cancelled
      </code>
      
       (sync-only: a hung tool never passes)
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
      Sandbox: tools this task may call (<code>
        server:tool
      </code>
      
       specs) — see <a href="../security">
        Security
      </a>
    </td>
  </tr>
</tbody>
</table>

### `server`

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
      Description
    </th>
  </tr>
</thead>

<tbody>
  <tr>
    <td>
      <code>
        transport
      </code>
    </td>
    
    <td>
      <code>
        'stdio' | 'http'
      </code>
    </td>
    
    <td>
      <strong>
        Required.
      </strong>
      
       How to reach the server
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
      stdio only. Full argv, no shell (process-runner contract): <code>
        command[0]
      </code>
      
       is the executable
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        url
      </code>
    </td>
    
    <td>
      string
    </td>
    
    <td>
      http only. Streamable HTTP endpoint
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        headers
      </code>
    </td>
    
    <td>
      object
    </td>
    
    <td>
      http only. Extra headers — values may embed env refs, see below
    </td>
  </tr>
</tbody>
</table>

## Example: stdio server (local tool)

```json
{
  "tasks": [
    {
      "name": "ping-agent",
      "schedules": [{ "cron": "*/10 * * * *" }],
      "runner": "mcp",
      "config": {
        "server": { "transport": "stdio", "command": ["npx", "my-mcp-tool"] },
        "tool": "ping",
        "args": { "target": "prod" }
      }
    }
  ]
}
```

## Example: Streamable HTTP server (remote)

```json
{
  "tasks": [
    {
      "name": "sync-captions",
      "schedules": [{ "cron": "0 3 * * *" }],
      "runner": "mcp",
      "config": {
        "server": {
          "transport": "http",
          "url": "https://mcp.internal.example/mcp",
          "headers": { "Authorization": "Bearer ${SCHED_MCP_TOKEN}" }
        },
        "tool": "captions.sync",
        "args": { "full": true }
      }
    }
  ]
}
```

## Secrets never live in tasks.json

`tasks.json` is the desired state in git — header tokens do not belong there. Header
values embed **env refs** resolved from the daemon process at load (fail-fast if the
var is missing — the daemon refuses to start, same rule as the ssh runner's `auth`):

```json
"headers": { "Authorization": "Bearer ${SCHED_MCP_TOKEN}" }
```

`SCHED_MCP_TOKEN` is read from the daemon's environment; the tasks.json file stays
secret-free.

## Result mapping

<table>
<thead>
  <tr>
    <th>
      Server result
    </th>
    
    <th>
      Run outcome
    </th>
  </tr>
</thead>

<tbody>
  <tr>
    <td>
      text content blocks
    </td>
    
    <td>
      <code>
        succeeded
      </code>
      
       with the blocks joined by newlines
    </td>
  </tr>
  
  <tr>
    <td>
      non-text blocks (<code>
        image
      </code>
      
      , …)
    </td>
    
    <td>
      <code>
        succeeded
      </code>
      
      , block rendered as <code>
        [type: mimeType]
      </code>
      
       marker
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        structuredContent
      </code>
      
       only (no text)
    </td>
    
    <td>
      <code>
        succeeded
      </code>
      
      , serialized as JSON
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        isError: true
      </code>
    </td>
    
    <td>
      <code>
        failed
      </code>
      
       with the tool's text as the error
    </td>
  </tr>
  
  <tr>
    <td>
      connect / call failure
    </td>
    
    <td>
      <code>
        failed
      </code>
      
       with the transport error
    </td>
  </tr>
  
  <tr>
    <td>
      timeout (<code>
        timeoutMs
      </code>
      
      )
    </td>
    
    <td>
      <code>
        cancelled
      </code>
    </td>
  </tr>
</tbody>
</table>

## Security: sandbox (`allowedTools`)

The runner accepts an optional `server:tool` allowlist — see [Security](../security)
for the full model. A task whose server **or tool** is not allowlisted fails fast
at load **and** at run, before any connection opens:

```ts
createMcpRunner({ allowedTools: ['https://mcp.internal.example:*', 'npx*:read_*'] })
```

**stdio identity = command[0]** (the raw executable string, e.g. `npx`) — not the
full argv and not the resolved binary path. So a pattern like `npx-mytool*` from an
earlier revision could never match a server launched as `["npx", "my-mcp-tool"]`;
use `npx*`, or disambiguate with an absolute executable path (`/usr/local/bin/mytool`)
and pin that. An exact `command[0]` cannot discriminate between two servers launched
you the same executable — thin per-server sandboxing must live server-side.

The allowlist lives at the daemon/embedding boundary — the operator decides which MCP
servers the scheduler may call, not the tasks.json author.

An http server-only spec must carry a tool dimension (`url:*` or `url:tool`); a
bare `https://host` fails at load — it would parse as server `https` and silently
match nothing (a footgun on a security allowlist).
