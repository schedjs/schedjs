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
    name: 'get_schedule',
    description: 'Get one schedule by id, including its effective pause status.',
    inputSchema: {
      type: 'object',
      properties: { scheduleId: { type: 'string', description: 'Schedule id' } },
      required: ['scheduleId'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_schedule',
    description:
      'Create (or upsert by dedupKey) a schedule for a task (mutation). ' +
      'schedule must be an object with exactly one of cron | interval | once, ' +
      'plus optional timezone/data/externalId/dedupKey/retry/priority. ' +
      'data is validated against the task inputSchema (see get_task).',
    inputSchema: {
      type: 'object',
      properties: {
        taskName: { type: 'string', description: 'Task name' },
        schedule: {
          type: 'object',
          description: '{ cron | interval | once, timezone?, data?, externalId?, dedupKey?, retry?, priority? }',
        },
        tz: { type: 'string', description: 'IANA timezone (default: the task tz)' },
      },
      required: ['taskName', 'schedule'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_schedule',
    description:
      'Edit a schedule in place (mutation, partial merge): only fields present change. ' +
      'schedule = { cron | interval | once, timezone?, data?, externalId?, dedupKey?, retry?, priority? } — ' +
      'inside the entry an explicit null clears (data/externalId/dedupKey/retry/priority); ' +
      'top-level schedule/tz must be present-or-absent (null → 400).',
    inputSchema: {
      type: 'object',
      properties: {
        scheduleId: { type: 'string', description: 'Schedule id' },
        schedule: {
          type: 'object',
          description: 'New rule/data/policy block (partial — absent fields keep current value)',
        },
        tz: { type: 'string', description: 'New timezone' },
      },
      required: ['scheduleId'],
      additionalProperties: false,
    },
  },
  {
    name: 'pause_schedule',
    description: 'Pause one schedule instance (mutation) — the task-level pause is a family stop.',
    inputSchema: {
      type: 'object',
      properties: { scheduleId: { type: 'string', description: 'Schedule id' } },
      required: ['scheduleId'],
      additionalProperties: false,
    },
  },
  {
    name: 'resume_schedule',
    description: 'Resume a paused schedule (mutation).',
    inputSchema: {
      type: 'object',
      properties: { scheduleId: { type: 'string', description: 'Schedule id' } },
      required: ['scheduleId'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_schedule',
    description: 'Delete a schedule (mutation); its runs keep their history.',
    inputSchema: {
      type: 'object',
      properties: { scheduleId: { type: 'string', description: 'Schedule id' } },
      required: ['scheduleId'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_task',
    description: 'Delete a task (mutation); its runs keep their history.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Task name' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_runs',
    description:
      'List runs, newest first. Optional filters: task (name), status (queued|running|succeeded|failed|cancelled), ' +
      'since/until (ISO-8601 start-time window, inclusive), runner (exact runner name), limit, offset.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Filter by task name' },
        status: {
          type: 'string',
          enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'],
          description: 'Filter by run status',
        },
        since: { type: 'string', description: 'Start of the started_at window, ISO-8601 (inclusive)' },
        until: { type: 'string', description: 'End of the started_at window, ISO-8601 (inclusive)' },
        runner: { type: 'string', description: "Exact runner match — 'docker', 'http', 'process'…" },
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
      'Trigger one run of a task immediately (mutation). Returns the created run. ' +
      'data (optional) — run parameters; validated against the task inputSchema (see get_task), ' +
      'which also renders the form: property types, defaults, descriptions.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Task name' },
        data: {
          description:
            'Run parameters (JSON object). Must match the task inputSchema — get_task returns the schema for form building.',
        },
      },
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
    name: 'pause_queue',
    description:
      'Pause the whole queue (mutation) — stop claiming work until resumed: recurring schedules are skipped ' +
      '(not caught up), once/retry work is deferred and played out on resume. Idempotent.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'resume_queue',
    description: 'Resume a paused queue (mutation) — deferred once/retry runs play out once. Idempotent.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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
  {
    name: 'cancel_run',
    description: 'Cancel a running or queued run (mutation). A terminal run returns 409.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'Run id' } },
      required: ['runId'],
      additionalProperties: false,
    },
  },
  {
    name: 'retry_run',
    description: 'Retry a finished run manually (mutation) — re-executes with the original data.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Run id' },
        triggeredBy: { type: 'string', description: 'Caller identity (optional)' },
      },
      required: ['runId'],
      additionalProperties: false,
    },
  },
];

/** Tools that change state — disabled in --readonly mode. */
export const MUTATIONS = new Set([
  'trigger_task',
  'pause_task',
  'resume_task',
  'pause_queue',
  'resume_queue',
  'delete_run',
  'create_schedule',
  'update_schedule',
  'pause_schedule',
  'resume_schedule',
  'delete_schedule',
  'delete_task',
  'cancel_run',
  'retry_run',
]);

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
    case 'get_schedule':
      return JSON.stringify(await client.getSchedule(requireStr(args, 'scheduleId')));
    case 'create_schedule': {
      const schedule = args.schedule;
      if (typeof schedule !== 'object' || schedule === null || Array.isArray(schedule)) {
        throw new Error(`argument 'schedule' must be an object: { cron | interval | once, data?, … }`);
      }
      const body: { taskName: string; schedule: Record<string, unknown>; tz?: string } = {
        taskName: requireStr(args, 'taskName'),
        schedule: schedule as Record<string, unknown>,
      };
      if (args.tz !== undefined) {
        if (typeof args.tz !== 'string') throw new Error(`argument 'tz' must be a string`);
        body.tz = args.tz;
      }
      return JSON.stringify(await client.createSchedule(body));
    }
    case 'update_schedule': {
      const patch: { schedule?: Record<string, unknown>; tz?: string } = {};
      if (args.schedule !== undefined) {
        if (typeof args.schedule !== 'object' || args.schedule === null || Array.isArray(args.schedule)) {
          throw new Error(`argument 'schedule' must be an object`);
        }
        patch.schedule = args.schedule as Record<string, unknown>;
      }
      if (args.tz !== undefined) {
        if (typeof args.tz !== 'string') throw new Error(`argument 'tz' must be a string`);
        patch.tz = args.tz;
      }
      return JSON.stringify(await client.updateSchedule(requireStr(args, 'scheduleId'), patch));
    }
    case 'pause_schedule':
      await client.pauseSchedule(requireStr(args, 'scheduleId'));
      return JSON.stringify({ ok: true });
    case 'resume_schedule':
      await client.resumeSchedule(requireStr(args, 'scheduleId'));
      return JSON.stringify({ ok: true });
    case 'delete_schedule':
      await client.deleteSchedule(requireStr(args, 'scheduleId'));
      return JSON.stringify({ ok: true });
    case 'delete_task':
      await client.deleteTask(requireStr(args, 'name'));
      return JSON.stringify({ ok: true });
    case 'cancel_run':
      return JSON.stringify(await client.cancelRun(requireStr(args, 'runId')));
    case 'retry_run': {
      const triggeredBy = args.triggeredBy;
      if (triggeredBy !== undefined && typeof triggeredBy !== 'string') {
        throw new Error(`argument 'triggeredBy' must be a string`);
      }
      return JSON.stringify(await client.retryRun(requireStr(args, 'runId'), triggeredBy));
    }
    case 'list_runs': {
      const filter: RunListFilter = {};
      if (args.task !== undefined) filter.task = requireStr(args, 'task');
      if (args.status !== undefined) filter.status = requireStr(args, 'status') as RunStatus;
      if (args.since !== undefined) filter.since = requireStr(args, 'since');
      if (args.until !== undefined) filter.until = requireStr(args, 'until');
      if (args.runner !== undefined) filter.runner = requireStr(args, 'runner');
      const limit = requireNum(args, 'limit', { min: 1 }); // schema promises minimum:1 — enforce it
      if (limit !== undefined) filter.limit = limit;
      const offset = requireNum(args, 'offset');
      if (offset !== undefined) filter.offset = offset;
      return JSON.stringify(await client.listRuns(filter));
    }
    case 'get_run':
      return JSON.stringify(await client.getRun(requireStr(args, 'runId')));
    case 'trigger_task':
      return JSON.stringify(await client.triggerTask(requireStr(args, 'name'), args.data));
    case 'pause_task':
      await client.pauseTask(requireStr(args, 'name'));
      return JSON.stringify({ ok: true });
    case 'resume_task':
      await client.resumeTask(requireStr(args, 'name'));
      return JSON.stringify({ ok: true });
    case 'pause_queue':
      return JSON.stringify(await client.setQueuePaused('pause'));
    case 'resume_queue':
      return JSON.stringify(await client.setQueuePaused('resume'));
    case 'delete_run':
      await client.deleteRun(requireStr(args, 'runId'));
      return JSON.stringify({ ok: true });
    default:
      throw new Error(`unknown tool '${name}'`);
  }
}
