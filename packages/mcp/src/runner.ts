import type { RunOutcome, Runner, TaskRecord } from '@schedjs/core';
import { assertValidMcpToolSpecs, isSubsetOf, matchesPattern, mcpToolAllowed, taskAllowedTools } from '@schedjs/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** Runner-specific config carried in `TaskRecord.config` (runner: 'mcp'). */
export interface McpRunnerConfig {
  /** Required. The MCP server to connect to for each run. */
  server: {
    /** stdio → spawn `command`; http → Streamable HTTP `url`. */
    transport: 'stdio' | 'http';
    /** stdio only. Full argv, no shell (process-runner contract): `command[0]` is the executable. */
    command?: string[];
    /** http only. Streamable HTTP endpoint URL. */
    url?: string;
    /**
     * HTTP headers. Values may embed env refs `"${SCHED_MCP_TOKEN}"` —
     * resolved at load (fail-fast if the var is missing). Secrets never live
     * in tasks.json (same rule as the ssh runner's auth).
     */
    headers?: Record<string, string>;
  };
  /** Required. The tool to call on the server. */
  tool: string;
  /** Static arguments for the tool call (JSON-serializable). */
  args?: Record<string, unknown>;
  /** Call timeout — the run is cancelled after this. Default: 5 min. */
  timeoutMs?: number;
  /**
   * Sandbox (per-task): tools this task may call, `server:tool` specs (exact
   * or trailing-`*` on either side: `['node:read_*', 'https://mcp.example.com:write_*']`).
   * Must be a subset of the runner ceiling. Omitted → allow all (ceiling
   * still applies at run).
   */
  allowedTools?: string[];
}

/** A live connection to one MCP server, ready to call a tool. */
export interface McpConnection {
  /** Invoke a tool by name; resolves with the server's CallToolResult. */
  callTool(tool: string, args: Record<string, unknown>): Promise<McpToolResult>;
  /** Tear the connection down (per-run connection is always closed). */
  close(): Promise<void> | void;
}

/** Shape of an MCP CallToolResult the runner understands (subset of the SDK's). */
export interface McpToolResult {
  content?: Array<{ type: string; text?: string; mimeType?: string; data?: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

/** Injectable connection factory — the ssh `transport` / docker `spawn` seam. */
export type McpConnectionFactory = (server: McpRunnerConfig['server']) => Promise<McpConnection>;

export interface McpRunnerOptions {
  /** Injectable connection factory for tests. Default: SDK Client over stdio / Streamable HTTP. */
  connect?: McpConnectionFactory;
  /**
   * Runner ceiling: tools this runner may ever call — `server:tool` specs
   * (exact or trailing-`*`). A task whose `config.allowedTools` is not a
   * subset fails at load. Empty/omitted = allow all. Fail-fast: a
   * non-allowlisted server/tool never opens a connection.
   */
  allowedTools?: string[];
  /** Default call timeout. Default: 5 min. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** The identity a server is allowlisted by: the URL (http) or command[0] (stdio). */
function serverKey(cfg: McpRunnerConfig['server']): string {
  return cfg.transport === 'http' ? cfg.url ?? '' : cfg.command?.[0] ?? '';
}

/** The sandbox tool identity: `server:tool` (mcpToolAllowed spec format). */
function toolKey(server: McpRunnerConfig['server'], tool: string): string {
  return `${serverKey(server)}:${tool}`;
}

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Resolve `${NAME}` refs in a header value; missing var → throw (load-time fail-fast). */
export function resolveHeaderEnv(value: string): string {
  return value.replace(ENV_REF, (m, name: string) => {
    const v = process.env[name];
    if (v === undefined) throw new Error(`header env ref '${name}' not set`);
    return v;
  });
}

/** Load-time shape check; returns an error string or null (ssh `configError` pattern). */
function configError(
  cfg: Partial<McpRunnerConfig>,
  ceiling: string[] | undefined,
  taskName: string,
): string | null {
  // policy first (admin's order): task allowedTools shape + ceiling subset,
  // then runner-specific shape (server/tool/headers).
  let tools: string[] | undefined;
  try {
    tools = taskAllowedTools(cfg, 'mcp', taskName);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  // spec-format validity (before subset math): an http server-only spec must
  // carry a tool dimension — a bare `https://host` is a silent no-match.
  try {
    assertValidMcpToolSpecs(ceiling);
    assertValidMcpToolSpecs(tools);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (tools && !isSubsetOf(tools, ceiling)) {
    return `config.allowedTools ${JSON.stringify(tools)} not a subset of runner allowedTools ${JSON.stringify(ceiling)}`;
  }
  const server = cfg.server as McpRunnerConfig['server'] | undefined;
  if (!server) return 'missing config.server';
  if (server.transport !== 'stdio' && server.transport !== 'http') {
    return `invalid config.server.transport '${String(server.transport)}' (expected 'stdio' | 'http')`;
  }
  if (server.transport === 'stdio') {
    if (!Array.isArray(server.command) || server.command.length === 0 || !isNonEmptyString(server.command[0])) {
      return 'missing config.server.command (stdio transport)';
    }
  } else {
    if (!isNonEmptyString(server.url)) return 'missing config.server.url (http transport)';
    try {
      new URL(server.url);
    } catch {
      return `invalid config.server.url '${server.url}'`;
    }
  }
  if (!isNonEmptyString(cfg.tool)) return 'missing config.tool';
  if (server.headers) {
    try {
      for (const v of Object.values(server.headers)) resolveHeaderEnv(v);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  if (!mcpToolAllowed(serverKey(server), cfg.tool!, ceiling)) {
    return `tool '${toolKey(server, cfg.tool!)}' not in runner allowedTools`;
  }
  return null;
}

/** Map CallToolResult content-blocks → a single result string. */
export function contentToResult(result: McpToolResult): string {
  const blocks = result.content ?? [];
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && b.text !== undefined) {
      parts.push(b.text);
    } else {
      parts.push(b.mimeType ? `[${b.type}: ${b.mimeType}]` : `[${b.type}]`);
    }
  }
  if (parts.length > 0) return parts.join('\n');
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
  return '';
}

/** Wrap a promise in a timeout; resolves `{ ok: false }` when the timer wins. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false; pending: Promise<T> }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false; pending: Promise<T> }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, pending: p }), ms);
  });
  try {
    return await Promise.race([p.then((value) => ({ ok: true as const, value })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Default factory: a real SDK Client over StdioClientTransport or StreamableHTTPClientTransport. */
async function defaultConnect(server: McpRunnerConfig['server']): Promise<McpConnection> {
  const client = new Client({ name: 'sched-mcp-runner', version: '0.0.0' });
  if (server.transport === 'stdio') {
    const [command, ...args] = server.command ?? [];
    const transport = new StdioClientTransport({ command: command ?? '', args });
    await client.connect(transport);
  } else {
    const headers = server.headers ? resolveHeaders(server.headers) : undefined;
    // exactOptionalPropertyTypes: the SDK's StreamableHTTPClientTransport doesn't satisfy the
    // strict Transport shape, but connect() works at runtime — cast through unknown.
    const transport = new StreamableHTTPClientTransport(new URL(server.url ?? ''), {
      ...(headers ? { requestInit: { headers } } : {}),
    }) as unknown as import('@modelcontextprotocol/sdk/shared/transport.js').Transport;
    await client.connect(transport);
  }
  return {
    callTool: (tool, args) =>
      client.callTool({ name: tool, arguments: args }) as unknown as Promise<McpToolResult>,
    close: () => client.close(),
  };
}

/** Header values with `${ENV}` refs resolved (all refs were validated at load). */
function resolveHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = resolveHeaderEnv(v);
  return out;
}

/**
 * MCP runner: calls a tool on an MCP server per run (sync-only — the run
 * resolves when `callTool` resolves, with a timeout → `cancelled`).
 *
 * Two transports: `stdio` spawns the server command (process-runner argv
 * contract, no shell); `http` speaks Streamable HTTP. Result mapping: text
 * content-blocks are joined into the run result, non-text blocks become
 * markers, `isError: true` → failed run, `structuredContent`-only results
 * serialize to JSON.
 *
 * Security: `allowedTools` sandbox — per-task `config.allowedTools` + runner
 * ceiling `options.allowedTools` (`server:tool` specs, fail-fast at load and
 * run) and header env-refs — secrets never live in tasks.json.
 */
export function createMcpRunner(options: McpRunnerOptions = {}): Runner {
  const connectImpl = options.connect ?? defaultConnect;
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ceiling = options.allowedTools;

  return {
    validateConfig(task: { name: string; config?: unknown }): void {
      const cfg = task.config as Partial<McpRunnerConfig>;
      const err = configError(cfg, ceiling, task.name);
      if (err) throw new Error(`mcp runner: task "${task.name}": ${err}`);
    },
    async run(task: TaskRecord, runId: string): Promise<RunOutcome> {
      const cfg = task.config as Partial<McpRunnerConfig>;
      const err = configError(cfg, ceiling, task.name);
      if (err) return { status: 'failed', error: `mcp runner: ${err}` };

      // fail-fast before connecting: the actual tool must pass the task's own
      // allowedTools AND the runner ceiling.
      const server = cfg.server!;
      const tool = cfg.tool!;
      const actual = toolKey(server, tool);
      let tools: string[] | undefined;
      try {
        tools = taskAllowedTools(cfg, 'mcp', task.name);
      } catch (e) {
        return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
      }
      if (!mcpToolAllowed(serverKey(server), tool, tools)) {
        return { status: 'failed', error: `mcp runner: tool '${actual}' not in config.allowedTools` };
      }
      if (!mcpToolAllowed(serverKey(server), tool, ceiling)) {
        return { status: 'failed', error: `mcp runner: tool '${actual}' not in runner allowedTools` };
      }
      const timeoutMs = cfg.timeoutMs ?? defaultTimeoutMs;

      let conn: McpConnection | null = null;
      try {
        const attempt = await withTimeout(connectImpl(server), timeoutMs);
        if (!attempt.ok) {
          // the connect did not settle in time — it may still land later (a stdio
          // subprocess keeps spawning). Stash the promise so we can tear it down.
          const pending = attempt.pending;
          void pending
            .then((c) => {
              try {
                c.close();
              } catch {
                // best-effort
              }
            })
            .catch(() => {});
          return { status: 'cancelled', error: `mcp runner: timeout after ${timeoutMs}ms (connect)` };
        }
        conn = attempt.value;
      } catch (e) {
        return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
      }

      const activeConn = conn;

      try {
        const call = await withTimeout(activeConn.callTool(tool, cfg.args ?? {}), timeoutMs);
        if (!call.ok) {
          return { status: 'cancelled', error: `mcp runner: timeout after ${timeoutMs}ms (tool '${tool}')` };
        }
        const result = call.value;
        const text = contentToResult(result);
        if (result.isError) {
          return { status: 'failed', error: text || `mcp tool '${tool}' returned isError` };
        }
        return { status: 'succeeded', result: text, log: null };
      } catch (e) {
        return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
      } finally {
        try {
          await conn.close();
        } catch {
          // best-effort teardown — a close failure must not mask the outcome
        }
      }
    },
  };
}
