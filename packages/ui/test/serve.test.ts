import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createServe } from '../src/serve.js';

const DIST_BUNDLE = fileURLToPath(new URL('../dist/sched-ui.bundle.js', import.meta.url));

describe('sched-ui serve', () => {
  const servers: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
  });

  async function startDaemonStub() {
    const stub = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
    const port = (stub.address() as AddressInfo).port;
    servers.push({ close: () => new Promise<void>((r) => stub.close(() => r())) });
    return `http://127.0.0.1:${port}`;
  }

  async function startServe(proxy: string, extra: Parameters<typeof createServe>[0] = {}) {
    const s = createServe({ port: 0, proxy, ...extra });
    servers.push(s);
    const port = await s.listen();
    return `http://127.0.0.1:${port}`;
  }

  it('serves the morda at /', async () => {
    const base = await startServe(await startDaemonStub());
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('sched-runs');
  });

  it('proxies /api/* to the upstream daemon (path + auth header pass through)', async () => {
    const base = await startServe(await startDaemonStub());
    const res = await fetch(`${base}/api/health`, { headers: { authorization: 'Bearer dev-key' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; path: string };
    expect(body.ok).toBe(true);
    expect(body.path).toBe('/api/health');
  });

  it('serves the component bundle at /sched-ui.bundle.js', async () => {
    const base = await startServe(await startDaemonStub(), { uiBundlePath: DIST_BUNDLE });
    const res = await fetch(`${base}/sched-ui.bundle.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect((await res.text()).length).toBeGreaterThan(1000);
  });

  it('404s unknown paths', async () => {
    const base = await startServe(await startDaemonStub());
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });

  it('serves the bundle with Cache-Control: no-store (mutable build, never cache)', async () => {
    const base = await startServe(await startDaemonStub(), { uiBundlePath: DIST_BUNDLE });
    const res = await fetch(`${base}/sched-ui.bundle.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('proxies /api/* with Cache-Control: no-cache (fresh snapshot, never stale)', async () => {
    const base = await startServe(await startDaemonStub());
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });
});
