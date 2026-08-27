# @schedjs/mcp

[![npm](https://img.shields.io/npm/v/@schedjs/mcp)](https://www.npmjs.com/package/@schedjs/mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-blue)](https://modelcontextprotocol.io)

Model Context Protocol server for the [`@schedjs/core`](https://www.npmjs.com/package/@schedjs/core)
cron scheduler — an **AI control plane**: list & get tasks and runs, trigger /
pause / resume, delete. Lets LLM tooling operate your scheduler over stdio or
Streamable HTTP.

## Features

- 9 MCP tools over the admin API.
- stdio + Streamable HTTP transports.
- `--readonly` guard for read-only deployments.

## Install

```bash
npm install -g @schedjs/mcp
```

## Usage

```bash
sched-mcp                     # stdio transport
sched-mcp --http              # Streamable HTTP transport
sched-mcp --readonly          # deny mutations
```

Configure in your MCP client (e.g. Claude, Cursor):

```json
{
  "mcpServers": {
    "sched": {
      "command": "sched-mcp",
      "args": ["--readonly"]
    }
  }
}
```

## Docs

- [MCP](https://schedjs.github.io/schedjs/docs/mcp)

## License

MIT — [sched](https://github.com/schedjs/schedjs).
