import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdminApi } from '../src/admin-api.js';
import { createSqliteStorage } from '@schedjs/core';

/**
 * Route-parity contract (openapi-spec task, 2026-08-18): the spec must not
 * drift from the router. Two guards:
 *  1. canonical endpoint list — the spec covers exactly the documented surface
 *     (matches the admin-api.ts docstring endpoint list);
 *  2. live probe — every documented [method, path] is RECOGNIZED by the router:
 *     the dispatch fallback is exactly `404 {error:'not found'}`, so a
 *     documented route must answer with anything else (specific 404 / 400 /
 *     405 / 200 / 204 / 501) — a generic 404 means the route no longer exists.
 */
const SPEC = JSON.parse(
  readFileSync(fileURLToPath(new URL('../openapi.json', import.meta.url)), 'utf8'),
) as { paths: Record<string, Record<string, unknown>> };

/** {idx} is a digit-only path segment in the router regex — substitute a real index. */
const PROBE_PARAM = (name: string): string => (name === 'idx' ? '0' : 'nonexistent');

/** Resolve a `#/components/...` reference to the actual node (for shape assertions). */
const resolveRef = (node: unknown, ref: string): unknown => {
  let cur = node as Record<string, unknown>;
  for (const part of ref.replace(/^#\//, '').split('/')) cur = cur[part] as Record<string, unknown>;
  return cur;
};

/** [method, path] → operation object. */
const op = (path: string, method: string): Record<string, any> =>
  (SPEC.paths[path] as Record<string, Record<string, any>>)[method]!;

/** 2xx response → its JSON schema (refs resolved, response components dug into). */
const okSchema = (path: string, method: string): any => {
  const opObj = op(path, method);
  const status = Object.keys(opObj.responses).find((c) => c.startsWith('2'))!;
  const resp = opObj.responses[status];
  let schema = resp.$ref ? resolveRef(SPEC, resp.$ref) : resp.content?.['application/json']?.schema;
  // response component → dig into its content
  if (schema && typeof schema === 'object' && 'content' in (schema as object)) {
    schema = (schema as any).content?.['application/json']?.schema;
  }
  return schema;
};

const ROUTES: Array<{ method: string; path: string }> = [];
for (const [path, ops] of Object.entries(SPEC.paths)) {
  for (const op of Object.keys(ops)) {
    if (op === 'parameters') continue;
    const probePath = path.replace(/\{([^}]+)\}/g, (_m, name: string) => PROBE_PARAM(name));
    ROUTES.push({ method: op.toUpperCase(), path: probePath });
  }
}

describe('openapi.json — route parity with the router', () => {
  const servers: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  const probe = async (method: string, path: string): Promise<{ status: number; error: string | undefined }> => {
    const storage = createSqliteStorage(new DatabaseSync(':memory:'));
    const api = createAdminApi({
      engine: {
        triggerTask: async () => null,
        retryRun: async () => null,
        cancelRun: async () => null,
      } as never,
      storage,
    });
    const port = await api.listen(0);
    servers.push({ close: () => api.close() });
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { status: res.status, error: body.error };
  };

  it('covers the canonical endpoint list (docstring-parity)', () => {
    expect(Object.keys(SPEC.paths).sort()).toEqual([
      '/health',
      '/queue',
      '/queue/pause',
      '/queue/resume',
      '/runs',
      '/runs/bulk/cancel',
      '/runs/bulk/retry',
      '/runs/{id}',
      '/runs/{id}/artifacts/{idx}',
      '/runs/{id}/cancel',
      '/runs/{id}/retry',
      '/schedules',
      '/schedules/{id}',
      '/schedules/{id}/pause',
      '/schedules/{id}/resume',
      '/tasks',
      '/tasks/{name}',
      '/tasks/{name}/pause',
      '/tasks/{name}/resume',
      '/tasks/{name}/run',
    ]);
  });

  it('every documented route is recognized by the router (no generic 404)', async () => {
    const misses: string[] = [];
    for (const { method, path } of ROUTES) {
      const r = await probe(method, path);
      if (r.status === 404 && r.error === 'not found') misses.push(`${method} ${path}`);
    }
    expect(misses).toEqual([]);
  }, 60000);
});

describe('openapi.json — response shapes match the server (F&F openapi-client report)', () => {
  it('F-2: mutations declare WRAPPED {task}/{run}/{schedule}; singular GETs stay bare', () => {
    const taskMut = okSchema('/tasks', 'post');
    expect(taskMut).toEqual({
      type: 'object',
      required: ['task'],
      properties: { task: { $ref: '#/components/schemas/TaskRecord' } },
    });
    expect(okSchema('/runs/{id}/retry', 'post').properties.run.$ref).toBe('#/components/schemas/RunRecord');
    expect(okSchema('/runs/{id}/cancel', 'post').properties.run.$ref).toBe('#/components/schemas/RunRecord');
    expect(okSchema('/tasks/{name}/run', 'post').properties.run.$ref).toBe('#/components/schemas/RunRecord');
    expect(okSchema('/schedules', 'post').properties.schedule.$ref).toBe('#/components/schemas/ScheduleRecord');
    expect(okSchema('/schedules/{id}', 'patch').properties.schedule.$ref).toBe('#/components/schemas/ScheduleRecord');
    // singular GETs keep the bare record
    expect(okSchema('/tasks/{name}', 'get').$ref).toBe('#/components/schemas/TaskRecord');
    expect(okSchema('/runs/{id}', 'get').allOf).toBeDefined(); // RunLogChunk (logFromOffset variant)
  });

  it('F-2: decorated fields are declared — TaskRecord.lastRunStatus, ScheduleRecord.lastRunStatus/effectiveStatus', () => {
    const schemas = (SPEC as any).components.schemas;
    const taskProps = schemas.TaskRecord.properties;
    expect(taskProps.lastRunStatus).toBeDefined();
    const schedProps = schemas.ScheduleRecord.properties;
    expect(schedProps.lastRunStatus).toBeDefined();
    expect(schedProps.effectiveStatus).toBeDefined();
  });

  it('F-3: no boolean const anywhere (openapi-generator compiles it to a string enum)', () => {
    const found: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (!node || typeof node !== 'object') return;
      const rec = node as Record<string, unknown>;
      if (typeof rec.const === 'boolean') found.push(path);
      for (const [k, v] of Object.entries(rec)) walk(v, `${path}.${k}`);
    };
    walk(SPEC, 'spec');
    expect(found).toEqual([]);
  });

  it('F-4: Schedule is a flat output schema (no oneOf/discriminator); once normalizes to `at`, interval to `ms`', () => {
    const sched = (SPEC as any).components.schemas.Schedule;
    expect(sched.oneOf).toBeUndefined();
    expect(sched.discriminator).toBeUndefined();
    expect(sched.required).toEqual(['kind']);
    const props = sched.properties;
    for (const p of ['kind', 'cron', 'timezone', 'ms', 'at']) expect(props[p]).toBeDefined();
  });
});
