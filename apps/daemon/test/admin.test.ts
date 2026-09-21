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

  it('wires /api/queue to the engine pause state (R2 — the daemon owns the accessor)', async () => {
    const { daemon, base, auth } = await startAdmin({ startPaused: true, now: () => NOW });

    // the start-paused freeze is visible through the API (pausedAt = process start)
    const state = await fetch(`${base}/api/queue`, { headers: auth });
    expect(state.status).toBe(200);
    expect(await state.json()).toEqual({ paused: true, pausedAt: NOW.toISOString(), startPaused: true });

    // resume through the API really unpauses the engine
    const resumed = await fetch(`${base}/api/queue/resume`, { method: 'POST', headers: auth });
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toEqual({ ok: true, paused: false, pausedAt: null });
    expect(daemon.engine.isPaused()).toBe(false);

    // repeat is idempotent (200, same state — never 409)
    expect((await fetch(`${base}/api/queue/resume`, { method: 'POST', headers: auth })).status).toBe(200);
    expect(await (await fetch(`${base}/api/queue`, { headers: auth })).json()).toEqual({
      paused: false,
      pausedAt: null,
      startPaused: false,
    });

    const paused = await fetch(`${base}/api/queue/pause`, { method: 'POST', headers: auth });
    expect(paused.status).toBe(200);
    expect(daemon.engine.isPaused()).toBe(true);
  });
});
