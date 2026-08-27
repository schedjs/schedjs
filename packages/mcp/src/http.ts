import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AdminApiClient } from './client.js';
import { createMcpServer, type McpServerHandle } from './server.js';

export interface McpHttpHandlerOptions {
  /** Admin API client — the MCP server is a projection of the admin API. */
  client: AdminApiClient;
  /** Read-only mode: mutations return a clear error (AI-operator safety gate). */
  readonly?: boolean;
  /**
   * Idle timeout (ms) after which a session is closed and dropped.
   * Default: 30 min. 0 disables the background sweep (lazy sweep still runs on requests).
   */
  sessionIdleMs?: number;
}

interface Session {
  mcp: McpServerHandle;
  transport: StreamableHTTPServerTransport;
  lastUsed: number;
}

const SESSION_HEADER = 'mcp-session-id';

function readSessionId(req: IncomingMessage): string | undefined {
  const v = req.headers[SESSION_HEADER];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Streamable HTTP handler for the sched MCP server.
 *
 * Why per-session Server instances (not one shared Server):
 * the MCP SDK's `Protocol.connect` owns a single transport — a second `connect`
 * throws "Already connected to a transport … use a separate Protocol instance
 * per connection". Creating one transport per request against a shared Server
 * broke every request after the first (500) and leaked listeners. Instead:
 *
 * - each session gets its own `Server` + `StreamableHTTPServerTransport`
 *   (stateful mode: `sessionIdGenerator` set) — the SDK-recommended shape;
 * - the transport's `onclose` (client DELETE, error, idle GC) removes the
 *   session from the map — no listener/session leak on long uptime;
 * - unknown `Mcp-Session-Id` → 404 (spec behavior for stateful servers);
 * - sessions idle past `sessionIdleMs` are closed by a background sweep
 *   (unref'd interval) plus a lazy sweep on every request.
 */
export function createMcpHttpHandler(options: McpHttpHandlerOptions) {
  const { client, readonly = false } = options;
  const idleMs = options.sessionIdleMs ?? 30 * 60 * 1000;
  const sessions = new Map<string, Session>();

  function drop(sessionId: string): void {
    const s = sessions.get(sessionId);
    if (s) {
      sessions.delete(sessionId);
      void s.transport.close(); // triggers onclose → safe even if already closing
    }
  }

  function sweep(): void {
    if (idleMs <= 0) return;
    const now = Date.now();
    for (const [sid, s] of sessions) {
      if (now - s.lastUsed > idleMs) drop(sid);
    }
  }

  // Background GC — unref'd so it never keeps the process alive.
  const gcTimer = setInterval(sweep, Math.max(idleMs / 4, 1000));
  gcTimer.unref();

  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      sweep(); // lazy GC on the request path
      const sessionId = readSessionId(req);
      const existing = sessionId ? sessions.get(sessionId) : undefined;

      if (sessionId && !existing) {
        // Unknown session id — stateful servers reject with 404 (MCP spec).
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unknown session id' }));
        return;
      }

      if (existing) {
        existing.lastUsed = Date.now();
        await existing.transport.handleRequest(req, res);
        return;
      }

      // New session: fresh Server + stateful transport (SDK: one Protocol per connection).
      // enableJsonResponse → direct JSON replies (sched MCP is request/response control-plane,
      // no server push), session id still echoed on every response.
      const mcp = createMcpServer({ client, readonly });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await mcp.connect(transport as unknown as Parameters<typeof mcp.connect>[0]);
      await transport.handleRequest(req, res);
      if (transport.sessionId) {
        sessions.set(transport.sessionId, { mcp, transport, lastUsed: Date.now() });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      } else {
        res.end();
      }
    }
  };
}
