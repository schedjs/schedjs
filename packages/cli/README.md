# @schedjs/cli

[![npm](https://img.shields.io/npm/v/@schedjs/cli)](https://www.npmjs.com/package/@schedjs/cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Operator CLI for the [`@schedjs/core`](https://www.npmjs.com/package/@schedjs/core)
cron scheduler — status, runs, tasks, schedules, trigger / pause / resume via
the admin API. Also ships a worker conformance checker.

## Install

```bash
npm install -g @schedjs/cli
```

## Usage

```bash
sched status                 # engine + daemon status
sched runs                   # recent runs
sched tasks                  # list tasks
sched trigger <task>         # fire a task now
sched pause <task>           # pause a schedule
sched resume <task>          # resume a schedule
```

## Docs

- [CLI](https://schedjs.github.io/schedjs/docs/cli)

## License

MIT — [sched](https://github.com/schedjs/schedjs).
