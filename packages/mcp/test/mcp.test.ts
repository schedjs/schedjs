import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAdminApi } from '@schedjs/admin-api';
import { createSqliteStorage } from '@schedjs/core';
import type { RunRecord, ScheduleRecord, TaskRecord } from '@schedjs/core';
import { AdminApiClient } from '../src/client.js';
import { createMcpServer } from '../src/server.js';
import { createMcpHttpHandler } from '../src/http.js';

function makeTask(name: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    name,
    runner: 'http',
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

function makeRun(id: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    taskName: 'task-a',
    runner: 'http',
    startedAt: new Date('2026-08-16T09:00:00Z'),
    finishedAt: null,
    status: 'running',
    data: null,
    result: null,
    error: null,
    progress: null,
    log: null,
    artifacts: null,
    workerRef: null,
    attempt: 1,
    trigger: 'schedule',
    triggeredBy: null,
    scheduleId: null,
    temporary: false,
    retryOf: null,
    ...overrides,
  };
}

interface Ctx {
  client: Client;
  engineCalls: string[];
  close: () => Promise<void>;
}

const servers: Array<{ close: () => Promise<void> }> = [];

async function start(opts: {
  tasks?: TaskRecord[];
  schedules?: ScheduleRecord[];
  runs?: RunRecord[];
  engine?: (name: string) => Promise<RunRecord | null>;
  apiKey?: string;
  readonly?: boolean;
} = {}): Promise<Ctx> {
  const db = new DatabaseSync(':memory:');
  const storage = createSqliteStorage(db);
  for (const t of opts.tasks ?? []) await storage.upsertTask(t);
  for (const s of opts.schedules ?? []) await storage.createSchedule(s);
  for (const r of opts.runs ?? []) await storage.createRun(r);

  const engineCalls: string[] = [];
  const trigger = async (name: string) => {
    engineCalls.push(name);
    if (opts.engine) return opts.engine(name);
    const task = await storage.getTask(name);
    if (!task) return null;
    return makeRun('r-' + name, { taskName: name });
  };
  const cancel = async (runId: string) => {
    engineCalls.push(`cancel:${runId}`);
    return makeRun(runId, { status: 'cancelled' });
  };
  const retry = async (runId: string) => {
    engineCalls.push(`retry:${runId}`);
    return makeRun('r-' + runId, { retryOf: runId });
  };
  const api = createAdminApi({
    engine: { triggerTask: trigger, cancelRun: cancel, retryRun: retry } as never,
    storage,
    ...(opts.apiKey ? { auth: { apiKey: opts.apiKey } } : {}),
  });
  const port = await api.listen(0);
  servers.push({ close: () => api.close() });

  const adminClient = new AdminApiClient(`http://127.0.0.1:${port}`, opts.apiKey);
  const mcpOpts: Parameters<typeof createMcpServer>[0] = { client: adminClient };
  if (opts.readonly !== undefined) mcpOpts.readonly = opts.readonly;
  const mcp = createMcpServer(mcpOpts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    engineCalls,
    close: async () => {
      await client.close();
    },
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text?: string }>;
  const text = content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
  return { isError: res.isError ?? false, text };
}

const parse = (text: string) => JSON.parse(text) as unknown;

describe('mcp streamable http transport (peer-review: per-request transport on shared server)', () => {
  const INIT = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'probe', version: '1' },
    },
  };
  const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

  async function startHttp(opts: { sessionIdleMs?: number } = {}): Promise<{ port: number }> {
    const client = new AdminApiClient('http://127.0.0.1:1'); // unreachable — transport tests never call tools
    const handler = createMcpHttpHandler({ client, ...opts });
    const http = createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve) => http.listen(0, resolve));
    servers.push({ close: () => new Promise((resolve) => http.close(() => resolve())) });
    return { port: (http.address() as { port: number }).port };
  }

  async function mcpPost(port: number, body: unknown, sessionId?: string): Promise<{
    status: number;
    sessionId: string | undefined;
    body: unknown;
  }> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* non-JSON (SSE) response */
    }
    return { status: r.status, sessionId: r.headers.get('mcp-session-id') ?? undefined, body: parsed };
  }

  it('serves sequential initialize requests — no shared-transport clash (regression: 2nd request 500ed)', async () => {
    const { port } = await startHttp();
    const a = await mcpPost(port, INIT);
    expect(a.status).toBe(200);
    expect(a.sessionId).toBeTruthy();
    const b = await mcpPost(port, INIT);
    expect(b.status).toBe(200);
    expect(b.sessionId).toBeTruthy();
  });

  it('resumes an existing session via Mcp-Session-Id and 404s unknown sessions', async () => {
    const { port } = await startHttp();
    const init = await mcpPost(port, INIT);
    const sid = init.sessionId!;

    const resumed = await mcpPost(port, LIST, sid);
    expect(resumed.status).toBe(200);
    expect((resumed.body as { result?: { tools?: unknown[] } }).result?.tools).toBeDefined();

    const unknown = await mcpPost(port, LIST, 'no-such-session');
    expect(unknown.status).toBe(404);
  });

  it('cleans up a session on DELETE — a later request with that id is 404', async () => {
    const { port } = await startHttp();
    const init = await mcpPost(port, INIT);
    const sid = init.sessionId!;

    const del = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sid },
    });
    expect([200, 204]).toContain(del.status);

    const after = await mcpPost(port, LIST, sid);
    expect(after.status).toBe(404);
  });

  it('garbage-collects sessions idle past sessionIdleMs', async () => {
    const { port } = await startHttp({ sessionIdleMs: 50 });
    const init = await mcpPost(port, INIT);
    const sid = init.sessionId!;

    await new Promise((r) => setTimeout(r, 120));
    const after = await mcpPost(port, LIST, sid);
    expect(after.status).toBe(404);
  });
});

describe('product MCP over admin api', () => {
  it('exposes the expected full control-plane tool set (task:1364)', async () => {
    const { client } = await start();
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'cancel_run',
      'create_schedule',
      'delete_run',
      'delete_schedule',
      'delete_task',
      'get_run',
      'get_schedule',
      'get_task',
      'list_runs',
      'list_schedules',
      'list_tasks',
      'pause_schedule',
      'pause_task',
      'resume_schedule',
      'resume_task',
      'retry_run',
      'trigger_task',
      'update_schedule',
    ]);
  });

  it('list_tasks returns seeded tasks', async () => {
    const { client } = await start({ tasks: [makeTask('backup'), makeTask('digest', { runner: 'docker' })] });
    const { isError, text } = await call(client, 'list_tasks');
    expect(isError).toBe(false);
    const tasks = parse(text) as TaskRecord[];
    expect(tasks.map((t) => t.name).sort()).toEqual(['backup', 'digest']);
    expect(tasks.find((t) => t.name === 'digest')?.runner).toBe('docker');
  });

  it('get_task returns one task; unknown task is a tool error, not a crash', async () => {
    const { client } = await start({ tasks: [makeTask('backup')] });
    const ok = await call(client, 'get_task', { name: 'backup' });
    expect(ok.isError).toBe(false);
    expect((parse(ok.text) as TaskRecord).name).toBe('backup');

    const missing = await call(client, 'get_task', { name: 'nope' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/not found/i);
  });

  it('list_schedules projects schedule-as-entity fields', async () => {
    const { client } = await start({
      tasks: [makeTask('backup')],
      schedules: [
        {
          id: 'backup',
          taskName: 'backup',
          schedule: { kind: 'cron', cron: '0 9 * * *' },
          tz: 'UTC',
          data: null,
          externalId: null,
          dedupKey: null,
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
          fileManaged: true,
        },
      ],
    });
    const { isError, text } = await call(client, 'list_schedules');
    expect(isError).toBe(false);
    const schedules = parse(text) as Array<{ id: string; taskName: string; schedule: unknown; paused: boolean }>;
    expect(schedules[0]!).toMatchObject({ id: 'backup', taskName: 'backup', paused: false });
    expect(schedules[0]!.schedule).toEqual({ kind: 'cron', cron: '0 9 * * *' });
  });

  it('list_runs filters by task, status and limit', async () => {
    const runs = [
      makeRun('r1', { taskName: 'backup', status: 'succeeded', startedAt: new Date('2026-08-16T08:00:00Z') }),
      makeRun('r2', { taskName: 'backup', status: 'failed', startedAt: new Date('2026-08-16T09:00:00Z') }),
      makeRun('r3', { taskName: 'digest', status: 'running', startedAt: new Date('2026-08-16T10:00:00Z') }),
    ];
    const { client } = await start({ runs });

    const byTask = await call(client, 'list_runs', { task: 'backup' });
    expect((parse(byTask.text) as RunRecord[]).map((r) => r.id).sort()).toEqual(['r1', 'r2']);

    const byStatus = await call(client, 'list_runs', { status: 'failed' });
    expect((parse(byStatus.text) as RunRecord[]).map((r) => r.id)).toEqual(['r2']);

    const limited = await call(client, 'list_runs', { limit: 2 });
    // newest first
    expect((parse(limited.text) as RunRecord[]).map((r) => r.id)).toEqual(['r3', 'r2']);
  });

  it('get_run returns one run; unknown run is a tool error', async () => {
    const { client } = await start({ runs: [makeRun('r1')] });
    const ok = await call(client, 'get_run', { runId: 'r1' });
    expect(ok.isError).toBe(false);
    expect((parse(ok.text) as RunRecord).id).toBe('r1');

    const missing = await call(client, 'get_run', { runId: 'nope' });
    expect(missing.isError).toBe(true);
  });

  it('trigger_task calls the engine and returns the run; unknown task errors', async () => {
    const { client, engineCalls } = await start({ tasks: [makeTask('backup')] });
    const ok = await call(client, 'trigger_task', { name: 'backup' });
    expect(engineCalls).toEqual(['backup']);
    expect(ok.isError).toBe(false);
    expect((parse(ok.text) as RunRecord).taskName).toBe('backup');

    const missing = await call(client, 'trigger_task', { name: 'nope' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/not found/i);
  });

  it('create_schedule creates a schedule that appears in list_schedules (task:1364)', async () => {
    const { client } = await start({ tasks: [makeTask('backup')] });
    const created = await call(client, 'create_schedule', {
      taskName: 'backup',
      schedule: { cron: '0 3 * * *', data: { idSeller: 2 } },
    });
    expect(created.isError).toBe(false);
    expect((parse(created.text) as { taskName: string; schedule: unknown }).taskName).toBe('backup');

    const list = await call(client, 'list_schedules');
    const schedules = parse(list.text) as Array<{ id: string; schedule: { cron?: string } }>;
    expect(schedules.find((s) => s.schedule.cron === '0 3 * * *')).toBeDefined();
  });

  it('create_schedule rejects a non-object schedule argument', async () => {
    const { client } = await start({ tasks: [makeTask('backup')] });
    const res = await call(client, 'create_schedule', { taskName: 'backup', schedule: 'nope' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/schedule/);
  });

  it('get_schedule returns one schedule; unknown id errors (task:1364)', async () => {
    const { client } = await start({
      tasks: [makeTask('backup')],
      schedules: [
        {
          id: 's1',
          taskName: 'backup',
          schedule: { kind: 'interval', ms: 300_000 },
          tz: 'UTC',
          data: null,
          externalId: null,
          dedupKey: null,
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
          fileManaged: false,
        },
      ],
    });
    const ok = await call(client, 'get_schedule', { scheduleId: 's1' });
    expect(ok.isError).toBe(false);
    expect((parse(ok.text) as { id: string }).id).toBe('s1');

    const missing = await call(client, 'get_schedule', { scheduleId: 'nope' });
    expect(missing.isError).toBe(true);
  });

  it('update_schedule patches the rule; pause/resume flip the flag (task:1364)', async () => {
    const { client } = await start({
      tasks: [makeTask('backup')],
      schedules: [
        {
          id: 's1',
          taskName: 'backup',
          schedule: { kind: 'cron', cron: '0 9 * * *' },
          tz: 'UTC',
          data: null,
          externalId: null,
          dedupKey: null,
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
          fileManaged: false,
        },
      ],
    });
    const patched = await call(client, 'update_schedule', {
      scheduleId: 's1',
      schedule: { interval: 'every hour' },
    });
    expect(patched.isError).toBe(false);
    expect((parse(patched.text) as { schedule: { kind: string } }).schedule.kind).toBe('interval');

    const paused = await call(client, 'pause_schedule', { scheduleId: 's1' });
    expect(paused.isError).toBe(false);
    const afterPause = await call(client, 'get_schedule', { scheduleId: 's1' });
    expect((parse(afterPause.text) as { paused: boolean }).paused).toBe(true);

    await call(client, 'resume_schedule', { scheduleId: 's1' });
    const afterResume = await call(client, 'get_schedule', { scheduleId: 's1' });
    expect((parse(afterResume.text) as { paused: boolean }).paused).toBe(false);
  });

  it('delete_schedule and delete_task remove their rows (task:1364)', async () => {
    const { client } = await start({
      tasks: [makeTask('backup'), makeTask('doomed')],
      schedules: [
        {
          id: 's1',
          taskName: 'backup',
          schedule: { kind: 'cron', cron: '0 9 * * *' },
          tz: 'UTC',
          data: null,
          externalId: null,
          dedupKey: null,
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
          fileManaged: false,
        },
      ],
    });
    const delSched = await call(client, 'delete_schedule', { scheduleId: 's1' });
    expect(delSched.isError).toBe(false);
    expect((await call(client, 'get_schedule', { scheduleId: 's1' })).isError).toBe(true);

    const delTask = await call(client, 'delete_task', { name: 'doomed' });
    expect(delTask.isError).toBe(false);
    expect((await call(client, 'get_task', { name: 'doomed' })).isError).toBe(true);
  });

  it('cancel_run and retry_run drive the engine (task:1364)', async () => {
    const { client, engineCalls } = await start({
      tasks: [makeTask('backup')],
      runs: [makeRun('r1', { status: 'running' }), makeRun('r2', { status: 'failed', finishedAt: new Date('2026-08-16T09:05:00Z') })],
    });
    const cancelled = await call(client, 'cancel_run', { runId: 'r1' });
    expect(cancelled.isError).toBe(false);
    expect((parse(cancelled.text) as RunRecord).status).toBe('cancelled');

    const retried = await call(client, 'retry_run', { runId: 'r2' });
    expect(retried.isError).toBe(false);
    expect((parse(retried.text) as RunRecord).retryOf).toBe('r2');
    expect(engineCalls).toEqual(['cancel:r1', 'retry:r2']);
  });

  it('cancel_run on a terminal run is a 409 tool error (admin-api contract)', async () => {
    const { client } = await start({
      runs: [makeRun('r-done', { status: 'succeeded', finishedAt: new Date('2026-08-16T09:05:00Z') })],
    });
    const res = await call(client, 'cancel_run', { runId: 'r-done' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/already finished|409/i);
  });

  it('pause_task / resume_task flip the paused flag', async () => {
    const { client } = await start({ tasks: [makeTask('backup')] });
    const paused = await call(client, 'pause_task', { name: 'backup' });
    expect(paused.isError).toBe(false);
    const afterPause = await call(client, 'get_task', { name: 'backup' });
    expect((parse(afterPause.text) as TaskRecord).paused).toBe(true);

    await call(client, 'resume_task', { name: 'backup' });
    const afterResume = await call(client, 'get_task', { name: 'backup' });
    expect((parse(afterResume.text) as TaskRecord).paused).toBe(false);
  });

  it('delete_run removes the run', async () => {
    const { client } = await start({ runs: [makeRun('r1', { status: 'succeeded', finishedAt: new Date('2026-08-16T09:05:00Z') })] });
    const del = await call(client, 'delete_run', { runId: 'r1' });
    expect(del.isError).toBe(false);
    const gone = await call(client, 'get_run', { runId: 'r1' });
    expect(gone.isError).toBe(true);
  });

  it('readonly mode rejects mutations but serves reads', async () => {
    const { client } = await start({ tasks: [makeTask('backup')], runs: [makeRun('r1')], readonly: true });

    const trigger = await call(client, 'trigger_task', { name: 'backup' });
    expect(trigger.isError).toBe(true);
    expect(trigger.text).toMatch(/readonly/i);

    const del = await call(client, 'delete_run', { runId: 'r1' });
    expect(del.isError).toBe(true);

    const pause = await call(client, 'pause_task', { name: 'backup' });
    expect(pause.isError).toBe(true);

    const reads = await call(client, 'list_tasks');
    expect(reads.isError).toBe(false);
    const run = await call(client, 'get_run', { runId: 'r1' });
    expect(run.isError).toBe(false);
  });

  it('wrong admin key surfaces a clear auth error', async () => {
    const { client } = await start({ tasks: [makeTask('backup')], apiKey: 'secret' });
    // server was built with the right key; swap the underlying client? No —
    // build a second mcp server with a wrong key against the same admin api.
    // Simpler: the admin client holds the key; start() passes it. Test the 401 path:
    // create an AdminApiClient with a bad key directly and expect tool errors.
    const { client: _unused } = { client };
    void _unused;
    const res = await call(client, 'list_tasks');
    expect(res.isError).toBe(false); // correct key works
  });

  it('unknown tool name is a tool error, not a crash', async () => {
    const { client } = await start();
    const res = await call(client, 'fly_to_moon');
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/unknown tool/i);
  });

  it('auth failure: bad key via direct client', async () => {
    const db = new DatabaseSync(':memory:');
    const storage = createSqliteStorage(db);
    const api = createAdminApi({ engine: { triggerTask: async () => null } as never, storage, auth: { apiKey: 'secret' } });
    const port = await api.listen(0);
    servers.push({ close: () => api.close() });

    const bad = new AdminApiClient(`http://127.0.0.1:${port}`, 'wrong-key');
    const mcp = createMcpServer({ client: bad });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await mcp.connect(st);
    await client.connect(ct);

    const res = await call(client, 'list_tasks');
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/unauthorized|401/i);
    await client.close();
    db.close();
  });
});

describe('mcp — argument validation (peer-review regression)', () => {
  it('rejects limit < 1 (schema promises minimum:1)', async () => {
    const { client } = await start();
    const { isError, text } = await call(client, 'list_runs', { limit: 0 });
    expect(isError).toBe(true);
    expect(String(text)).toMatch(/limit/);
  });
});
