# @schedjs/core

[![npm](https://img.shields.io/npm/v/@schedjs/core)](https://www.npmjs.com/package/@schedjs/core)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-schedjs.github.io%2Fschedjs-blue)](https://schedjs.github.io/schedjs)

Cron done right — **queue-based scheduler engine for Node.js**. Not a naive
cron trigger: every run is queued, recorded, retried with backoff, and survives
restarts. This package is the engine only; pair it with a storage adapter and a
runner, or use the standalone [`@schedjs/daemon`](https://www.npmjs.com/package/@schedjs/daemon).

## Features

- Queue-based execution (not fire-and-forget) — runs, retries with backoff, priority.
- Idempotency via `runId` — no double-fire on crash recovery.
- Cancellation that actually reaches the worker.
- Pluggable storage: SQLite (default), MariaDB/MySQL, PostgreSQL, MongoDB.
- Runners: in-process functions, child processes, HTTP workers, Docker, SSH.
- Run history with progress, stdout/stderr capture, and result artifacts.
- Lock + heartbeat with live-sync recovery.
- ESM-only, TypeScript types included.

## Install

Requires Node.js **>= 22.5**.

```bash
npm install @schedjs/core
```

## Quick start

```js
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

## Docs

- [Introduction](https://schedjs.github.io/schedjs/docs/introduction)
- [Quick start](https://schedjs.github.io/schedjs/docs/quick-start)
- [Tasks](https://schedjs.github.io/schedjs/docs/tasks)
- [Runs](https://schedjs.github.io/schedjs/docs/runs)
- [Storage](https://schedjs.github.io/schedjs/docs/storage)

## License

MIT — [sched](https://github.com/schedjs/schedjs).
