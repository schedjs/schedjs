import type { AdminApiClient, RunListFilter } from './client.js';
import type { RunStatus } from '@schedjs/core';

/** MCP tool definitions (JSON Schema inputs). Mirrors the admin API surface. */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOL_DEFS: McpToolDef[] = [
  {
    name: 'list_tasks',
    description:
      'List all scheduled tasks: name, runner, schedule, tz, nextRunAt, lastRunAt, paused, disabled.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_task',
    description: 'Get one task by name, including its full config.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Task name' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_schedules',
    description: 'List schedules: name, runner, schedule, tz, nextRunAt, lastRunAt, paused.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_runs',
    description:
      'List runs, newest first. Optional filters: task (name), status (queued|running|succeeded|failed|cancelled), limit, offset.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Filter by task name' },
        status: {
          type: 'string',
          enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'],
          description: 'Filter by run status',
        },
        limit: { type: 'integer', minimum: 1, description: 'Max runs to return (default: all)' },
        offset: { type: 'integer', minimum: 0, description: 'Pagination offset' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_run',
    description: 'Get one run by id: status, error, log, result, artifacts.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'Run id' } },
      required: ['runId'],
      additionalProperties: false,
    },
  },
  {
    name: 'trigger_task',
    description:
      'Trigger one run of a task immediately (mutation). Returns the created run.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Task name' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'pause_task',
    description: 'Pause a task — stop scheduling new runs until resumed (mutation).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Task name' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'resume_task',
    description: 'Resume a paused task (mutation).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Task name' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_run',
    description: 'Delete a run record from history (mutation). No-op for unknown run.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'Run id' } },
      required: ['runId'],
      additionalProperties: false,
    },
  },
];

/** Tools that change state — disabled in --readonly mode. */
export const MUTATIONS = new Set(['trigger_task', 'pause_task', 'resume_task', 'delete_run']);

function requireStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`missing required string argument '${key}'`);
  }
  return v;
}

function requireNum(args: Record<string, unknown>, key: string, opts: { min?: number } = {}): number | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new Error(`argument '${key}' must be an integer`);
  }
  if (opts.min !== undefined && v < opts.min) {
    throw new Error(`argument '${key}' must be >= ${opts.min}`);
  }
  return v;
}

/** Execute one tool against the admin API; returns JSON text for the MCP result. */
export async function runTool(
  client: AdminApiClient,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'list_tasks':
      return JSON.stringify(await client.listTasks());
    case 'get_task':
      return JSON.stringify(await client.getTask(requireStr(args, 'name')));
    case 'list_schedules':
      return JSON.stringify(await client.listSchedules());
    case 'list_runs': {
      const filter: RunListFilter = {};
      if (args.task !== undefined) filter.task = requireStr(args, 'task');
      if (args.status !== undefined) filter.status = requireStr(args, 'status') as RunStatus;
      const limit = requireNum(args, 'limit', { min: 1 }); // schema promises minimum:1 — enforce it
      if (limit !== undefined) filter.limit = limit;
      const offset = requireNum(args, 'offset');
      if (offset !== undefined) filter.offset = offset;
      return JSON.stringify(await client.listRuns(filter));
    }
    case 'get_run':
      return JSON.stringify(await client.getRun(requireStr(args, 'runId')));
    case 'trigger_task':
      return JSON.stringify(await client.triggerTask(requireStr(args, 'name')));
    case 'pause_task':
      await client.pauseTask(requireStr(args, 'name'));
      return JSON.stringify({ ok: true });
    case 'resume_task':
      await client.resumeTask(requireStr(args, 'name'));
      return JSON.stringify({ ok: true });
    case 'delete_run':
      await client.deleteRun(requireStr(args, 'runId'));
      return JSON.stringify({ ok: true });
    default:
      throw new Error(`unknown tool '${name}'`);
  }
}
