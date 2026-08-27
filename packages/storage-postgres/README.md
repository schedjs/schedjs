# @schedjs/storage-postgres

[![npm](https://img.shields.io/npm/v/@schedjs/storage-postgres)](https://www.npmjs.com/package/@schedjs/storage-postgres)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

PostgreSQL storage adapter for the [`@schedjs/core`](https://www.npmjs.com/package/@schedjs/core)
cron scheduler engine — contract-tested. Use it when run history must live in
your existing PostgreSQL.

## Install

```bash
npm install @schedjs/core @schedjs/storage-postgres
```

## Usage

```js
import { createEngine, createInternalRunner } from '@schedjs/core'
import { createPostgresStorage } from '@schedjs/storage-postgres'

const engine = createEngine({
  storage: await createPostgresStorage({
    host: 'localhost',
    port: 5432,
    user: 'sched',
    password: process.env.DB_PASSWORD,
    database: 'sched',
  }),
  runner: createInternalRunner({ handlers: { /* ... */ } }),
})

engine.start()
```

`createStorage(env)` also reads `POSTGRES_URL` from the environment, matching
the storage-module contract used by the daemon.

## Storage contract

All sched storage adapters pass the same shared contract suite, so swapping
SQLite → Postgres → Mongo changes nothing in your task definitions.

## Docs

- [Storage](https://schedjs.github.io/schedjs/docs/storage)

## License

MIT — [sched](https://github.com/schedjs/schedjs).
