# @schedjs/admin-api

[![npm](https://img.shields.io/npm/v/@schedjs/admin-api)](https://www.npmjs.com/package/@schedjs/admin-api)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Admin REST control plane for the [`@schedjs/core`](https://www.npmjs.com/package/@schedjs/core)
cron scheduler — tasks, runs, schedules over HTTP with Bearer auth. Consumed by
the [`@schedjs/daemon`](https://www.npmjs.com/package/@schedjs/daemon), the
[`@schedjs/cli`](https://www.npmjs.com/package/@schedjs/cli), the
[`@schedjs/mcp`](https://www.npmjs.com/package/@schedjs/mcp) server, and the
[`@schedjs/ui`](https://www.npmjs.com/package/@schedjs/ui) dashboard.

## Features

- Tasks / runs / schedules REST endpoints.
- Bearer-token auth (`x-sched-api-key` compatible outbound).
- Triggered-by forwarding.
- OpenAPI spec shipped in the package (`openapi.json`).

## Install

```bash
npm install @schedjs/admin-api
```

## Usage

```js
import { createAdminApi } from '@schedjs/admin-api'

const api = createAdminApi({
  // wire it into your engine / daemon server
})

// openapi.json — typed client generation
```

## Docs

- [Admin API](https://schedjs.github.io/schedjs/docs/admin-api)

## License

MIT — [sched](https://github.com/schedjs/schedjs).
