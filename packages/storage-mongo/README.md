# @schedjs/storage-mongo

[![npm](https://img.shields.io/npm/v/@schedjs/storage-mongo)](https://www.npmjs.com/package/@schedjs/storage-mongo)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

MongoDB storage adapter for the [`@schedjs/core`](https://www.npmjs.com/package/@schedjs/core)
cron scheduler engine — contract-tested, bring-your-own-history path. Use it
when run history must live in your existing MongoDB.

## Install

```bash
npm install @schedjs/core @schedjs/storage-mongo
```

## Usage

```js
import { MongoClient } from 'mongodb'
import { createEngine, createInternalRunner } from '@schedjs/core'
import { createMongoStorage } from '@schedjs/storage-mongo'

const client = new MongoClient(process.env.MONGO_URL)
await client.connect()

const engine = createEngine({
  storage: await createMongoStorage(client.db('sched')),
  runner: createInternalRunner({ handlers: { /* ... */ } }),
})

engine.start()
```

`createStorage(env)` also reads `MONGO_URL` / `MONGO_DB` from the environment,
matching the storage-module contract used by the daemon.

## Storage contract

All sched storage adapters pass the same shared contract suite, so swapping
SQLite → Mongo → Postgres changes nothing in your task definitions.

## Docs

- [Storage](https://schedjs.github.io/schedjs/docs/storage)

## License

MIT — [sched](https://github.com/schedjs/schedjs).
