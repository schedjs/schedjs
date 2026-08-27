#!/usr/bin/env node
import { createServer } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AdminApiClient } from './client.js';
import { createMcpServer } from './server.js';
import { createMcpHttpHandler } from './http.js';
import { VERSION } from './index.js';

interface CliOptions {
  adminUrl: string;
  apiKey?: string;
  httpPort?: number;
  readonly: boolean;
}

function usage(): string {
  return `sched-mcp v${VERSION} — product MCP server for sched (control plane over the admin API)

Usage:
  sched-mcp [--admin-url URL] [--api-key KEY] [--http PORT] [--readonly]

Options:
  --admin-url URL   Admin API base URL (env: SCHED_ADMIN_URL, default http://127.0.0.1:8080)
  --api-key KEY     Admin API bearer key (env: SCHED_ADMIN_KEY; unset → open dev mode)
  --http PORT       Serve Streamable HTTP on PORT (default: stdio transport)
  --readonly        Read-only: list/get tools only, mutations rejected
  -h, --help        Show this help

Transports:
  stdio   — default; for local AI clients (Claude Desktop, codex, pi): npx sched-mcp
  http    — Streamable HTTP on PORT; for remote/daemon-side hosting

Examples:
  sched-mcp --admin-url http://127.0.0.1:8080 --api-key $SCHED_ADMIN_KEY
  sched-mcp --http 8091 --admin-url http://127.0.0.1:8080 --readonly
`;
}

function parseArgs(argv: string[]): CliOptions | 'help' {
  const opts: CliOptions = {
    adminUrl: process.env.SCHED_ADMIN_URL ?? 'http://127.0.0.1:8080',
    readonly: false,
  };
  const envKey = process.env.SCHED_ADMIN_KEY;
  if (envKey) opts.apiKey = envKey;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case '-h':
      case '--help':
        return 'help';
      case '--admin-url':
        opts.adminUrl = next();
        break;
      case '--api-key':
        opts.apiKey = next();
        break;
      case '--http': {
        const raw = next();
        const port = Number(raw);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`bad port '${raw}'`);
        opts.httpPort = port;
        break;
      }
      case '--readonly':
        opts.readonly = true;
        break;
      default:
        throw new Error(`unknown option '${arg}'`);
    }
  }
  return opts;
}

async function main(): Promise<void> {
  let opts: CliOptions | 'help';
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${usage()}`);
    process.exit(2);
  }
  if (opts === 'help') {
    process.stdout.write(usage());
    process.exit(0);
  }

  const client = new AdminApiClient(opts.adminUrl, opts.apiKey);
  const mcp = createMcpServer({ client, readonly: opts.readonly });

  if (opts.httpPort !== undefined) {
    const handleRequest = createMcpHttpHandler({ client, readonly: opts.readonly });
    const httpServer = createServer((req, res) => {
      void handleRequest(req, res);
    });
    httpServer.listen(opts.httpPort, () => {
      process.stderr.write(
        `sched-mcp v${VERSION} — Streamable HTTP on http://127.0.0.1:${opts.httpPort} (admin: ${opts.adminUrl}, readonly: ${opts.readonly})\n`,
      );
    });
  } else {
    await mcp.connect(new StdioServerTransport());
    process.stderr.write(`sched-mcp v${VERSION} — stdio (admin: ${opts.adminUrl}, readonly: ${opts.readonly})\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`sched-mcp: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
