# HTTP runner

> Run tasks over HTTP — request/response, sync or accepted + poll

The HTTP runner fires a request per the task's config. Two modes:

- **Simple (default)** — raw `config.body`, any 2xx = `succeeded`, run id sent in the
`x-sched-run-id` header.
- **Envelope mode** (`config.envelope: true`) — the request body becomes
`{ task: { name, config }, data }` and the response is parsed per the
[runner protocol](../protocol) (sync or `202 accepted` + poll).

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
      Description
    </th>
  </tr>
</thead>

<tbody>
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
      <strong>
        Required.
      </strong>
      
       Request URL
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        method
      </code>
    </td>
    
    <td>
      string
    </td>
    
    <td>
      HTTP method (default <code>
        GET
      </code>
      
      )
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
      Extra request headers
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        body
      </code>
    </td>
    
    <td>
      unknown
    </td>
    
    <td>
      Request body (simple mode; also the <code>
        data
      </code>
      
       fallback in envelope mode)
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
      Protocol mode (v2): <code>
        { task, data }
      </code>
      
       body + envelope response parsing
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
      Run parameters for the envelope's <code>
        data
      </code>
      
       field. Takes priority over <code>
        body
      </code>
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
      <strong>
        Transport
      </strong>
      
       timeout for one request (dispatch and poll), default 30s. The <strong>
        run
      </strong>
      
       deadline is the task-level <code>
        timeoutMs
      </code>
      
       (see below) — an explicit <code>
        config.timeoutMs
      </code>
      
       override wins over it
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        auth
      </code>
    </td>
    
    <td>
      <code>
        { apiKey, header? }
      </code>
    </td>
    
    <td>
      Outbound auth — sent on dispatch <strong>
        and
      </strong>
      
       poll
    </td>
  </tr>
</tbody>
</table>

## Outbound auth

```json
{
  "url": "https://worker.example.com/run",
  "method": "POST",
  "envelope": true,
  "auth": { "apiKey": "secret-key" }
}
```

The key is sent as `x-sched-api-key` by default (override the header name with
`auth.header`). It is attached to **both** the dispatch request and every poll request.
Validation happens at config load (fail-fast): `apiKey` must be non-empty.

## Envelope mode example

Task hitting a worker that implements the protocol:

```json
{
  "name": "publish-video",
  "schedules": [{ "cron": "* * * * *" }],
  "config": {
    "url": "https://worker.example.com/publish",
    "method": "POST",
    "envelope": true,
    "data": { "videoId": "v-42" },
    "auth": { "apiKey": "secret" }
  }
}
```

The worker receives:

```json
{
  "task": { "name": "publish-video", "config": { "url": "...", "envelope": true, "data": { "videoId": "v-42" } } },
  "data": { "videoId": "v-42" }
}
```

and answers with a sync envelope or `202 accepted` + `statusUrl` — see the
[runner protocol](../protocol) for the response shapes.

## Envelope-mode guardrails (battle-stand hardening)

- **Broken worker, never silent success.** `envelope: true` + a 2xx response
without a valid envelope (no `status` field) fails the run with
`envelope mode but non-envelope 2xx body — broken worker` — the simple-mode
fallback only applies when envelope mode is off.
- **Relative statusUrl is resolved** against `config.url` (`/status/<id>` →
origin-relative, `status/<id>` → path-relative). A worker must not know its
external address; absolute URLs pass through unchanged. The optional
**cancelUrl** in the accepted envelope is resolved the same way — see the
[cancel channel](../protocol#cancel) in the runner protocol.
- **Transient poll failures are retried** (network errors, 5xx, 408/429 — 2
retries by default, 500 ms apart; tune via `createHttpRunner({ pollRetries, pollRetryDelayMs })`). Every poll-originated failure is recorded as
`http runner: poll failed: <reason>` so the operator can tell a lost poll
from a worker-reported failure.
- **Async cancel.** On `POST /runs/:id/cancel` of a `queued`/async run, the
runner POSTs `{ runId }` to the worker's advertised `cancelUrl` (same auth +
`x-sched-run-id`) before the engine finishes the run `cancelled`. The same
signal fires on **auto-termination** — when an async run hits its
`pollTimeoutMs` or per-task `timeoutMs` ceiling, the runner POSTs `{ runId }`
to `cancelUrl` before the engine fails the run, so a timed-out worker stops at
the next stage boundary instead of mutating after the `failed` verdict. A worker
without a `cancelUrl` is left to finish on its own (legacy stop-polling).
- **Run deadline.** The dispatch request is capped by the task-level `timeoutMs`
when it governs: `timeoutMs: -1` (the default when omitted) removes the
transport timeout entirely (only the engine/manual abort stops the run — for
hour-scale sync tasks), a positive `timeoutMs` caps the dispatch at the
deadline. Poll requests keep their own short transport guard (the run duration
is bounded by the task deadline / engine `pollTimeoutMs`, not by poll latency).
