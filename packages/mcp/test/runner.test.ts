import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TaskRecord } from '@schedjs/core';
import { createMcpRunner, type McpConnection, type McpToolResult } from '../src/runner.js';

function makeTask(name: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    name,
    runner: 'mcp',
    schedule: { kind: 'cron', cron: '0 9 * * *' },
    tz: 'UTC',
    config: {},
    label: null,
    description: null,
    nextRunAt: new Date('2026-08-16T09:00:00Z'),
    lastRunAt: null,
    lockedAt: null,
    failCount: 0,
    priority: 0,
    retry: null,
    retryCount: 0,
    lastRunId: null,
    paused: false,
    disabled: false,
    ...overrides,
  };
}

const origEnv = { ...process.env };
afterEach(() => {
  process.env = { ...origEnv };
});

/** Real SDK round-trip: a mock MCP server tool reached through a real Client over InMemoryTransport. */
async function mockServerConnection(
  tool: string,
  handler: (args: Record<string, unknown>) => unknown,
): Promise<McpConnection> {
  const server = new McpServer({ name: 'mock-server', version: '1.0.0' });
  server.registerTool(
    tool,
    {
      title: tool,
      inputSchema: z.record(z.string(), z.unknown()),
    },
    async (args) => handler((args as Record<string, unknown>) ?? {}) as never,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'sched-test', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    callTool: async (name, args) => (await client.callTool({ name, arguments: args })) as unknown as McpToolResult,
    close: async () => {
      await client.close();
    },
  };
}

describe('mcp runner — validateConfig (load-time fail-fast)', () => {
  it('rejects a task without config.server', () => {
    const runner = createMcpRunner();
    expect(() => runner.validateConfig?.(makeTask('t', { config: { tool: 'echo' } }))).toThrow(/server/);
  });

  it('rejects a task without config.tool', () => {
    const runner = createMcpRunner();
    expect(() =>
      runner.validateConfig?.(makeTask('t', { config: { server: { transport: 'stdio', command: ['npx', 'mcp-server'] } } })),
    ).toThrow(/tool/);
  });

  it('rejects stdio transport without command', () => {
    const runner = createMcpRunner();
    expect(() =>
      runner.validateConfig?.(makeTask('t', { config: { server: { transport: 'stdio' }, tool: 'echo' } })),
    ).toThrow(/command/);
  });

  it('rejects http transport without url', () => {
    const runner = createMcpRunner();
    expect(() =>
      runner.validateConfig?.(makeTask('t', { config: { server: { transport: 'http' }, tool: 'echo' } })),
    ).toThrow(/url/);
  });

  it('rejects an unknown transport', () => {
    const runner = createMcpRunner();
    expect(() =>
      runner.validateConfig?.(makeTask('t', { config: { server: { transport: 'carrier-pigeon' }, tool: 'echo' } })),
    ).toThrow(/transport/);
  });

  it('rejects an invalid http url', () => {
    const runner = createMcpRunner();
    expect(() =>
      runner.validateConfig?.(
        makeTask('t', { config: { server: { transport: 'http', url: 'not a url' }, tool: 'echo' } }),
      ),
    ).toThrow(/url/);
  });

  it('allowedTools: fail-fast when the server is not allowlisted', () => {
    const runner = createMcpRunner({ allowedTools: ['https://mcp.internal.example:*'] });
    expect(() =>
      runner.validateConfig?.(
        makeTask('t', { config: { server: { transport: 'http', url: 'https://other.example/mcp' }, tool: 'echo' } }),
      ),
    ).toThrow(/allowedTools/);
  });

  it('allowedTools: bare http server-only spec fails at load (silent no-match footgun)', () => {
    const runner = createMcpRunner({ allowedTools: ['https://mcp.internal.example'] });
    expect(() =>
      runner.validateConfig?.(
        makeTask('t', { config: { server: { transport: 'http', url: 'https://mcp.internal.example' }, tool: 'echo' } }),
      ),
    ).toThrow(/tool dimension/);

    const perTask = createMcpRunner();
    expect(() =>
      perTask.validateConfig?.(
        makeTask('t', {
          config: { server: { transport: 'http', url: 'https://mcp.internal.example' }, tool: 'echo', allowedTools: ['https://mcp.internal.example'] },
        }),
      ),
    ).toThrow(/tool dimension/);
  });

  it('allowedTools: http spec with a port but no tool fails at load (port eaten into tool dimension)', () => {
    const runner = createMcpRunner({ allowedTools: ['https://127.0.0.1:1'] });
    expect(() =>
      runner.validateConfig?.(
        makeTask('t', { config: { server: { transport: 'http', url: 'https://127.0.0.1:1' }, tool: 'ping' } }),
      ),
    ).toThrow(/tool dimension/);

    const perTask = createMcpRunner();
    expect(() =>
      perTask.validateConfig?.(
        makeTask('t', {
          config: { server: { transport: 'http', url: 'https://127.0.0.1:1' }, tool: 'ping', allowedTools: ['https://127.0.0.1:1'] },
        }),
      ),
    ).toThrow(/tool dimension/);
  });

  it('allowedTools: server-only spec allows any tool on that server (old allowedServers semantics)', () => {
    const runner = createMcpRunner({ allowedTools: ['https://mcp.internal.example:*', 'npx-tool*'] });
    expect(() =>
      runner.validateConfig?.(
        makeTask('t', { config: { server: { transport: 'http', url: 'https://mcp.internal.example' }, tool: 'echo' } }),
      ),
    ).not.toThrow();
    expect(() =>
      runner.validateConfig?.(
        makeTask('t', { config: { server: { transport: 'stdio', command: ['npx-tool', 'serve'] }, tool: 'echo' } }),
      ),
    ).not.toThrow();
  });

  it('allowedTools: a stdio no-colon spec (command[0] only) = any tool on that server', () => {
    const runner = createMcpRunner({ allowedTools: ['node'] });
    expect(() =>
      runner.validateConfig?.(
        makeTask('t', { config: { server: { transport: 'stdio', command: ['node', 'srv.mjs'] }, tool: 'echo' } }),
      ),
    ).not.toThrow();
    // different server → blocked
    expect(() =>
      runner.validateConfig?.(
        makeTask('t', { config: { server: { transport: 'stdio', command: ['deno', 'srv.ts'] }, tool: 'echo' } }),
      ),
    ).toThrow(/allowedTools/);
  });

  it('allowedTools: server:tool spec restricts the tool on an allowlisted server (the admin gap)', () => {
    const runner = createMcpRunner({ allowedTools: ['https://mcp.internal.example:read_*'] });
    // allowed tool on the allowed server → ok
    expect(() =>
      runner.validateConfig?.(
        makeTask('t', { config: { server: { transport: 'http', url: 'https://mcp.internal.example' }, tool: 'read_data' } }),
      ),
    ).not.toThrow();
    // OTHER tool on the SAME server → blocked (this is the mcp allowedTools gap from F&F r3)
    expect(() =>
      runner.validateConfig?.(
        makeTask('t', { config: { server: { transport: 'http', url: 'https://mcp.internal.example' }, tool: 'write_all' } }),
      ),
    ).toThrow(/allowedTools/);
    // http server with a port — the spec must carry the port too (last-colon split)
    const ported = createMcpRunner({ allowedTools: ['https://mcp.internal.example:8443:ping'] });
    expect(() =>
      ported.validateConfig?.(
        makeTask('t', { config: { server: { transport: 'http', url: 'https://mcp.internal.example:8443' }, tool: 'ping' } }),
      ),
    ).not.toThrow();
  });

  it('allowedTools: allowlist checks the command[0] for stdio', () => {
    const runner = createMcpRunner({ allowedTools: ['node'] });
    expect(() =>
      runner.validateConfig?.(
        makeTask('t', { config: { server: { transport: 'stdio', command: ['deno', 'run', 'srv.ts'] }, tool: 'echo' } }),
      ),
    ).toThrow(/allowedTools/);
  });

  it('allowedTools: per-task list must be a subset of the runner ceiling', () => {
    const runner = createMcpRunner({ allowedTools: ['node:read_*'] });
    expect(() =>
      runner.validateConfig?.(
        makeTask('t', {
          config: { server: { transport: 'stdio', command: ['node', 'srv.ts'] }, tool: 'read_data', allowedTools: ['node:write_*'] },
        }),
      ),
    ).toThrow(/not a subset/);
  });

  it('header env-secrets: missing env var fails at load', () => {
    delete process.env.SCHED_MCP_TOKEN;
    const runner = createMcpRunner();
    expect(() =>
      runner.validateConfig?.(
        makeTask('t', {
          config: {
            server: { transport: 'http', url: 'https://mcp.example', headers: { Authorization: '${SCHED_MCP_TOKEN}' } },
            tool: 'echo',
          },
        }),
      ),
    ).toThrow(/SCHED_MCP_TOKEN/);
  });

  it('header env-secrets: inline ref resolves when the env var exists', () => {
    process.env.SCHED_MCP_TOKEN = 'sekrit';
    const runner = createMcpRunner();
    expect(() =>
      runner.validateConfig?.(
        makeTask('t', {
          config: {
            server: { transport: 'http', url: 'https://mcp.example', headers: { Authorization: 'Bearer ${SCHED_MCP_TOKEN}' } },
            tool: 'echo',
          },
        }),
      ),
    ).not.toThrow();
  });
});

describe('mcp runner — run against a real SDK mock server', () => {
  it('succeeded: joins text content blocks into result', async () => {
    const runner = createMcpRunner({
      connect: () => mockServerConnection('echo', () => ({ content: [{ type: 'text', text: 'hello' }] })),
    });
    const task = makeTask('t', { config: { server: { transport: 'stdio', command: ['mock'] }, tool: 'echo' } });
    const out = await runner.run(task, 'run-1', new Date());
    expect(out).toMatchObject({ status: 'succeeded', result: 'hello' });
  });

  it('succeeded: joins multiple text blocks with newlines', async () => {
    const runner = createMcpRunner({
      connect: () =>
        mockServerConnection('echo', () => ({
          content: [
            { type: 'text', text: 'line one' },
            { type: 'text', text: 'line two' },
          ],
        })),
    });
    const out = await runner.run(makeTask('t', { config: { server: { transport: 'http', url: 'https://x' }, tool: 'echo' } }), 'run-1', new Date());
    expect(out).toMatchObject({ status: 'succeeded', result: 'line one\nline two' });
  });

  it('failed: isError:true maps to a failed run with the tool text', async () => {
    const runner = createMcpRunner({
      connect: () =>
        mockServerConnection('echo', () => ({
          content: [{ type: 'text', text: 'boom: partition full' }],
          isError: true,
        })),
    });
    const out = await runner.run(makeTask('t', { config: { server: { transport: 'http', url: 'https://x' }, tool: 'echo' } }), 'run-1', new Date());
    expect(out).toMatchObject({ status: 'failed', error: 'boom: partition full' });
  });

  it('non-text blocks render as markers', async () => {
    const runner = createMcpRunner({
      connect: () =>
        mockServerConnection('echo', () => ({
          content: [
            { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
            { type: 'text', text: 'done' },
          ],
        })),
    });
    const out = await runner.run(makeTask('t', { config: { server: { transport: 'http', url: 'https://x' }, tool: 'echo' } }), 'run-1', new Date());
    expect(out).toMatchObject({ status: 'succeeded', result: '[image: image/png]\ndone' });
  });

  it('structuredContent-only results serialize to JSON', async () => {
    const runner = createMcpRunner({
      connect: () =>
        mockServerConnection('echo', () => ({
          content: [],
          structuredContent: { ok: true, count: 3 },
        })),
    });
    const out = await runner.run(makeTask('t', { config: { server: { transport: 'http', url: 'https://x' }, tool: 'echo' } }), 'run-1', new Date());
    expect(out).toMatchObject({ status: 'succeeded', result: JSON.stringify({ ok: true, count: 3 }) });
  });

  it('config.args are forwarded to the tool call', async () => {
    let seen: unknown;
    const runner = createMcpRunner({
      connect: () =>
        mockServerConnection('echo', (args) => {
          seen = args;
          return { content: [{ type: 'text', text: 'ok' }] };
        }),
    });
    const out = await runner.run(
      makeTask('t', { config: { server: { transport: 'http', url: 'https://x' }, tool: 'echo', args: { bucket: 'logs' } } }),
      'run-1',
      new Date(),
    );
    expect(seen).toEqual({ bucket: 'logs' });
    expect(out.status).toBe('succeeded');
  });

  it('tool errors surface as failed runs', async () => {
    const runner = createMcpRunner({
      connect: () => mockServerConnection('echo', () => ({ content: [{ type: 'text', text: 'boom' }], isError: true })),
    });
    const out = await runner.run(makeTask('t', { config: { server: { transport: 'http', url: 'https://x' }, tool: 'echo' } }), 'run-1', new Date());
    expect(out.status).toBe('failed');
  });
});

describe('mcp runner — connection lifecycle and timeout', () => {
  it('connect failure → failed run', async () => {
    const runner = createMcpRunner({
      connect: () => Promise.reject(new Error('connection refused: no such host')),
    });
    const out = await runner.run(makeTask('t', { config: { server: { transport: 'http', url: 'https://x' }, tool: 'echo' } }), 'run-1', new Date());
    expect(out).toMatchObject({ status: 'failed', error: 'connection refused: no such host' });
  });

  it('closes the connection after a successful run', async () => {
    let closed = 0;
    const runner = createMcpRunner({
      connect: () =>
        Promise.resolve({
          callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
          close: () => {
            closed++;
          },
        }),
    });
    await runner.run(makeTask('t', { config: { server: { transport: 'http', url: 'https://x' }, tool: 'echo' } }), 'run-1', new Date());
    expect(closed).toBe(1);
  });

  it('timeout → cancelled (sync-only: hung tool call never passes)', async () => {
    const runner = createMcpRunner({
      timeoutMs: 50,
      connect: () =>
        Promise.resolve({
          callTool: () => new Promise<never>(() => {}),
          close: () => {},
        }),
    });
    const out = await runner.run(makeTask('t', { config: { server: { transport: 'http', url: 'https://x' }, tool: 'echo' } }), 'run-1', new Date());
    expect(out).toMatchObject({ status: 'cancelled', error: expect.stringMatching(/timeout/) });
  });

  it('per-config timeoutMs overrides the default', async () => {
    const runner = createMcpRunner({
      timeoutMs: 10_000,
      connect: () =>
        Promise.resolve({
          callTool: () => new Promise<never>(() => {}),
          close: () => {},
        }),
    });
    const out = await runner.run(
      makeTask('t', { config: { server: { transport: 'http', url: 'https://x' }, tool: 'echo', timeoutMs: 50 } }),
      'run-1',
      new Date(),
    );
    expect(out.status).toBe('cancelled');
  });

  it('connect timeout tears down the eventually-landed connection (peer-review: resource leak)', async () => {
    let closed = 0;
    let resolveConnect: () => void = () => {};
    const runner = createMcpRunner({
      timeoutMs: 30,
      connect: () =>
        new Promise((res) => {
          resolveConnect = () => res({
            callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
            close: () => {
              closed++;
            },
          });
        }),
    });
    const out = await runner.run(makeTask('t', { config: { server: { transport: 'http', url: 'https://x' }, tool: 'echo' } }), 'run-1', new Date());
    // run reports cancelled on the connect timeout
    expect(out).toMatchObject({ status: 'cancelled', error: expect.stringMatching(/connect/) });
    // …but when the connect later lands, the connection is still closed (no stranded stdio child)
    resolveConnect();
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(1);
  });

  it('allowedTools fail-fast at run time too (per-task + ceiling)', async () => {
    const runner = createMcpRunner({ allowedTools: ['https://ok.example:*'] });
    const out = await runner.run(
      makeTask('t', { config: { server: { transport: 'http', url: 'https://evil.example' }, tool: 'echo' } }),
      'run-1',
      new Date(),
    );
    expect(out).toMatchObject({ status: 'failed', error: expect.stringMatching(/allowedTools/) });

    // per-task: task declares only read_* but calls write_data → blocked before connect
    let connected = 0;
    const guarded = createMcpRunner({
      connect: (async () => {
        connected += 1;
        return { callTool: async () => ({ content: [] }), close: async () => {} };
      }) as never,
    });
    const blocked = await guarded.run(
      makeTask('t', {
        config: {
          server: { transport: 'stdio', command: ['node', 'srv.mjs'] },
          tool: 'write_data',
          allowedTools: ['node:read_*'],
        },
      }),
      'run-2',
      new Date(),
    );
    expect(connected).toBe(0);
    expect(blocked.status).toBe('failed');
  });
});
