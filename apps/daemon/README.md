# @schedjs/daemon

[![npm](https://img.shields.io/npm/v/@schedjs/daemon)](https://www.npmjs.com/package/@schedjs/daemon)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/docker-ghcr.io%2Fschedjs%2Fsched--daemon-blue)](https://github.com/schedjs/schedjs/pkgs/container/sched-daemon)

Standalone cron scheduler daemon for Node.js — SQLite + HTTP runner +
`tasks.json` in one process. Binary: `schedd`. This is the turnkey way to run
[`@schedjs/core`](https://www.npmjs.com/package/@schedjs/core): no code, just
configure tasks and run.

## Install

```bash
npm install -g @schedjs/daemon
```

Or with Docker:

```bash
docker run ghcr.io/schedjs/sched-daemon:latest
```

## Usage

```bash
schedd --tasks tasks.json      # run from a tasks file
schedd --help
```

Example `tasks.json`:

```json
{
  "tasks": [
    {
      "name": "nightly-backup",
      "schedules": [{ "cron": "0 2 * * *" }],
      "runner": "http",
      "config": { "url": "http://worker:3000/backup" }
    }
  ]
}
```

Runs survive restarts, locks are reaped, and every run is recorded in SQLite
(switchable to MySQL/MariaDB, Postgres, or Mongo via storage adapters).

## Docs

- [Self-hosting](https://schedjs.github.io/schedjs/docs/self-hosting)
- [Quick start](https://schedjs.github.io/schedjs/docs/quick-start)

## License

MIT — [sched](https://github.com/schedjs/schedjs).
