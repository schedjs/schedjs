import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AdminApiClient, AdminApiError } from './client.js';
import { MUTATIONS, TOOL_DEFS, runTool } from './tools.js';

export interface McpServerOptions {
  /** Admin API client — the MCP server is a projection of the admin API. */
  client: AdminApiClient;
  /** Read-only mode: mutations return a clear error (AI-operator safety gate). */
  readonly?: boolean;
}

export interface McpServerHandle {
  server: Server;
  connect(transport: Transport): Promise<void>;
}

/**
 * Product MCP server for sched. Exposes control-plane tools (list/get tasks &
 * runs, trigger/pause/resume, delete) over the admin API. The confirm gate for
 * mutations lives in the AI-client layer (propose → human approves → call).
 */
export function createMcpServer(options: McpServerOptions): McpServerHandle {
  const { client, readonly = false } = options;

  const server = new Server(
    { name: 'sched', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (readonly && MUTATIONS.has(name)) {
        return {
          content: [{ type: 'text', text: `readonly mode: '${name}' is a mutation and is disabled` }],
          isError: true,
        };
      }
      const text = await runTool(client, name, args);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      const message =
        err instanceof AdminApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  });

  return {
    server,
    connect(transport: Transport) {
      return server.connect(transport);
    },
  };
}
