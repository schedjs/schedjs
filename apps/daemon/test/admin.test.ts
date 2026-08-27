import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createDaemon, type DaemonOptions } from '../src/daemon.js';
import type { RunRecord, TaskRecord } from '@schedjs/core';

const FIXTURE = fileURLToPath(new URL('./fixtures/tasks.json', import.meta.url));
const NOW = new Date('2026-08-16T12:00:00Z');

describe('daemon admin server', () => {
  const daemons: ReturnType<typeof createDaemon>[] = [];
  afterEach(() => {
    for (const d of daemons.splice(0)) d.stop();
  });

  async function startAdmin(overrides: Partial<DaemonOptions> = {}) {
    const daemon = createDaemon({
      tasksPath: FIXTURE,
      dbPath: ':memory:',
      runners: {
        test: {
          async run() {
            return { status: 'succeeded' as const, result: { ok: true } };
          },
        },
      },
      ...overrides,
      admin: { port: 0, apiKey: 'k1', ...(overrides.admin ?? {}) },
    });
    await daemon.start();
    daemons.push(daemon);
    const port = (daemon.getAdminServer()!.address() as AddressInfo).port;
    return { daemon, base: `http://127.0.0.1:${port}`, auth: { Authorization: 'Bearer k1' } };
  }

  it('serves /api/* with bearer auth and a static index at /', async () => {
    const { base, auth } = await startAdmin();

    // F-1 (F&F round 2): GET /health is ALWAYS open — outside the auth zone,
    // even a wrong key gets 200 (compose/LB probes carry no credentials). The
    // spec declares security: [] on /health; docs/09.admin-api.md § Exception.
    const healthOpen = await fetch(`${base}/api/health`);
    expect(healthOpen.status).toBe(200);
    expect(((await healthOpen.json()) as { ok: boolean }).ok).toBe(true);
    expect((await fetch(`${base}/api/health`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(200);

    // everything else sits behind bearer auth
    expect((await fetch(`${base}/api/runs`)).status).toBe(401);

    const health = await fetch(`${base}/api/health`, { headers: auth });
    expect(health.status).toBe(200);
    expect(((await health.json()) as { ok: boolean }).ok).toBe(true);

    const runs = await fetch(`${base}/api/runs`, { headers: auth });
    expect(runs.status).toBe(200);
    expect(((await runs.json()) as { runs: RunRecord[] }).runs).toEqual([]);

    // the daemon is headless — the UI ships separately (@schedjs/ui)
    const idx = await fetch(`${base}/`);
    expect(idx.status).toBe(404);
    expect(await idx.text()).toContain('ships separately');
  });

  it('sets Cache-Control: no-store on every /api/* response (fresh snapshot, never stale)', async () => {
    const { base, auth } = await startAdmin();

    const health = await fetch(`${base}/api/health`, { headers: auth });
    expect(health.status).toBe(200);
    expect(health.headers.get('cache-control')).toBe('no-store');

    const runs = await fetch(`${base}/api/runs`, { headers: auth });
    expect(runs.status).toBe(200);
    expect(runs.headers.get('cache-control')).toBe('no-store');

    // 4xx/204 responses carry the same header
    const del = await fetch(`${base}/api/runs/nonexistent`, { method: 'DELETE', headers: auth });
    expect(del.status).toBe(404);
    expect(del.headers.get('cache-control')).toBe('no-store');

    const trigger = await fetch(`${base}/api/tasks/every-minute/run`, { method: 'POST', headers: auth });
    expect(trigger.status).toBe(200);
    expect(trigger.headers.get('cache-control')).toBe('no-store');
  });

  it('exposes task list and run trigger over the api', async () => {
    const { base, auth } = await startAdmin();

    const tasks = (await (await fetch(`${base}/api/tasks`, { headers: auth })).json()) as { tasks: TaskRecord[] };
    expect(tasks.tasks.length).toBeGreaterThan(0);

    const trigger = await fetch(`${base}/api/tasks/every-minute/run`, {
      method: 'POST',
      headers: auth,
    });
    expect(trigger.status).toBe(200);
    expect(((await trigger.json()) as { run: RunRecord }).run.status).toBe('succeeded');
  });
});
