# sched

[![CI](https://github.com/schedjs/schedjs/actions/workflows/ci.yml/badge.svg)](https://github.com/schedjs/schedjs/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-schedjs.github.io%2Fschedjs-blue)](https://schedjs.github.io/schedjs)

A queue-based, self-hosted cron scheduler for modern apps — polyglot-ready,
built to be operated as a service. Schedule functions in-process, or run a
standalone daemon that dispatches HTTP/Docker/SSH workers with run history,
retries, priority, and alerts.

- **Queue-based, not naive-cron** — runs, retries with backoff, priority,
  idempotency via `runId`, cancellation that actually reaches the worker.
- **Polyglot workers** — workers are dumb HTTP endpoints (or Docker containers,
  SSH commands, in-process functions). Any language, any stack.
- **Self-hosted** — SQLite by default; MariaDB/MySQL, PostgreSQL, and MongoDB
  adapters. No SaaS required.
- **Operable** — admin REST API, web UI, CLI, MCP server for AI tooling, status
  alerts via webhook.

Full documentation: [sched docs](docs/content/docs/01.introduction.md) — quick
start, task format, runner protocol, storage, self-hosting, security.

## Quick start (5 minutes)

Requires Node.js **>= 22.5**. Install and schedule a function in-process:

```bash
npm install @schedjs/core
```

```js
// embed.mjs — sched as a library (the package is ESM-only)
import { DatabaseSync } from 'node:sqlite'
import { createEngine, createInternalRunner, createSqliteStorage, syncTasks } from '@schedjs/core'

const engine = createEngine({
  storage: createSqliteStorage(new DatabaseSync('sched.db')),
  runner: createInternalRunner({
    handlers: {
      generateThumbnail: async (data) => ({ thumb: `thumb-${data.videoId}.png` }),
    },
  }),
  maxConcurrent: 4,
})

await syncTasks(storage, [
  {
    name: 'generate-thumbnail',
    runner: 'internal',
    schedules: [{ cron: '0 9 * * *' }],
    config: { handler: 'generateThumbnail', data: { videoId: 'v-42' } },
  },
], new Date())

engine.start() // fires daily at 09:00
```

Run history, retries with backoff, priority and alerts — all included; the
daemon (`schedd --tasks tasks.json`) is just the standalone form for
HTTP/Docker/SSH workers. The operator CLI is `sched status` (from `@schedjs/cli`).

Want HTTP workers, the admin UI, or the webhook alerts? See the
[quick start in the docs](docs/content/docs/02.quick-start.md) for the daemon
and Docker paths.

## Packages

| Package | What it is |
|---|---|
| `@schedjs/core` | Engine, storages, runners — the library |
| `@schedjs/daemon` | Standalone daemon, binary `schedd` |
| `@schedjs/admin-api` | Admin REST surface over the engine |
| `@schedjs/cli` | Operator CLI, binary `sched` |
| `@schedjs/mcp` | MCP server (stdio / Streamable HTTP) |
| `@schedjs/ui` | Web admin UI components + `sched-ui serve` |
| `@schedjs/storage-mongo` / `-mysql` / `-postgres` | Storage adapters |

## License

MIT — see [LICENSE](LICENSE). Contributions require a CLA
([details](CONTRIBUTING.md)); the `sched` name and logo are trademarks and are
not granted under the license.
