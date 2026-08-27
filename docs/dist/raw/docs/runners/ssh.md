# SSH runner

> Run remote commands over SSH

The SSH runner executes a remote command per run over an SSH connection (`ssh2`),
captures stdout+stderr, and maps the exit code to the run status — the same sync
mapping as the [Docker](docker) and [Process](process) runners, but on a remote host.

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
        host
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
      
       Remote host
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        port
      </code>
    </td>
    
    <td>
      number
    </td>
    
    <td>
      22
    </td>
    
    <td>
      SSH port
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        username
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
      
       Remote user
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        command
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
      
       The remote shell command (POSIX sh on the far side)
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        auth
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
      
       Exactly one of <code>
        keyFromEnv
      </code>
      
       / <code>
        passwordFromEnv
      </code>
      
       — see below
    </td>
  </tr>
  
  <tr>
    <td>
      <code>
        fingerprints
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
      Host-key pins — see below
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
      <strong>
        Command
      </strong>
      
       (exec) timeout → <code>
        cancelled
      </code>
      
      . Connect is bounded separately by the ssh2 handshake (15 s) → <code>
        failed
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
      Sandbox: commands this task may run on the remote host (first token of <code>
        command
      </code>
      
      ) — see <a href="../security">
        Security
      </a>
    </td>
  </tr>
</tbody>
</table>

## Secrets never live in tasks.json

`tasks.json` is the desired state in git — private keys and passwords do not belong
there. `auth` references **env vars** of the daemon process:

```json
{
  "tasks": [
    {
      "name": "restart-nginx",
      "schedules": [{ "cron": "0 4 * * *" }],
      "runner": "ssh",
      "config": {
        "host": "vds.example",
        "username": "root",
        "command": "systemctl restart nginx && systemctl is-active nginx",
        "auth": { "keyFromEnv": "SCHED_SSH_KEY_PRD" },
        "fingerprints": ["SHA256:qIMWQ8C7H7yPK2dXk2HFGZ9nXq0cQv3VKoHzJ2pKx8M="]
      }
    }
  ]
}
```

- `keyFromEnv: "SCHED_SSH_KEY_PRD"` — the env var holds the PEM private key
(`-----BEGIN OPENSSH PRIVATE KEY-----…`)
- `passwordFromEnv` — the env var holds the password

A missing env var is a fail-fast: rejected at load time (`validateConfig`), never
reached at dispatch. Both sources set at once is a config error.

## Host-key pins

`fingerprints` is an array of the remote host's public-key fingerprints —
`SHA256:<base64>` (what `ssh-keyscan -t ed25519 <host>` prints), bare base64, or hex.
A host whose key is not pinned **fails the run** — this deliberately overrides the
ssh2 default of accepting any host key.

Omitted/empty = accept any host key. That is a convenience for trusted networks,
not a production posture.

On mismatch the run fails with an error that names the pins and the received
fingerprint — e.g. `Host key verification failed: received <fp>, expected one of [<pin1>, …]` — so you can tell which pin is stale when several are configured.

## Exit-code mapping

- `0` → `succeeded` (stdout+stderr captured into the run log)
- `!=0` → `failed` `exit N: <tail>`
- command timeout (`timeoutMs`) → `cancelled`
- connect timeout (ssh2 handshake, fixed 15 s) → `failed` — two different
timeouts: `timeoutMs` bounds the exec phase only, reachability is the handshake's
- connect/exec error (unreachable, bad auth, fingerprint mismatch) → `failed`

## Security notes

- The daemon's ssh private keys are read from env — protect them like any other
secret (service account, file perms, secret manager feeding env).
- The remote command runs through the remote shell — the operator writes it, the
same trust boundary as a cron line on that host.
- One connection per run; the connection is closed after every run regardless of
outcome.
- Sandbox ceiling is enforced at load too: a task whose command's first token is
outside the runner `allowedTools` fails in `validateConfig` (fail-fast before
any run), matching process/docker/mcp — not only at run time.
