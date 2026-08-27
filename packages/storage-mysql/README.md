# @schedjs/storage-mysql

[![npm](https://img.shields.io/npm/v/@schedjs/storage-mysql)](https://www.npmjs.com/package/@schedjs/storage-mysql)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

MySQL / MariaDB storage adapter for the [`@schedjs/core`](https://www.npmjs.com/package/@schedjs/core)
cron scheduler engine — one `mysql2` driver, both dialects, contract-tested.
Use it when run history must live in your existing MySQL or MariaDB.

## Install

```bash
npm install @schedjs/core @schedjs/storage-mysql
```

## Usage

```js
import { createEngine, createInternalRunner } from '@schedjs/core'
import { createMysqlStorage } from '@schedjs/storage-mysql'

const engine = createEngine({
  storage: await createMysqlStorage({
    host: 'localhost',
    port: 3306,
    user: 'sched',
    password: process.env.DB_PASSWORD,
    database: 'sched',
  }),
  runner: createInternalRunner({ handlers: { /* ... */ } }),
})

engine.start()
```

`createStorage(env)` also reads `MYSQL_URL` from the environment, matching the
storage-module contract used by the daemon. MariaDB works out of the box.

## Storage contract

All sched storage adapters pass the same shared contract suite, so swapping
SQLite → MySQL → Postgres changes nothing in your task definitions.

## Docs

- [Storage](https://schedjs.github.io/schedjs/docs/storage)

## License

MIT — [sched](https://github.com/schedjs/schedjs).
