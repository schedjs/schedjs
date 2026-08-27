import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { mordaHtml, refreshFromSearch, serveStatic } from '../src/morda.js';

/** Minimal ServerResponse stub — collects status/headers/body. */
class FakeRes extends Writable {
  status = 0;
  headers: Record<string, string> = {};
  body = '';
  writeHead(code: number, h?: Record<string, string>) {
    this.status = code;
    if (h) this.headers = h;
    return this;
  }
  _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
    this.body += chunk.toString();
    cb();
  }
}

function res() {
  return new FakeRes();
}

/** FakeRes is a writable stub, not a full ServerResponse — cast at the boundary. */
const asServer = (r: FakeRes): ServerResponse => r as unknown as ServerResponse;

describe('morda serveStatic', () => {
  it('serves /sched-ui.bundle.js from uiBundlePath', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-ui-'));
    const bundle = join(dir, 'bundle.js');
    writeFileSync(bundle, 'export const ui = 1;');
    const r = res();
    serveStatic('/sched-ui.bundle.js', asServer(r), { uiBundlePath: bundle });
    // the bundle is streamed — wait for the writable to finish
    await new Promise<void>((resolve) => r.on('finish', () => resolve()));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/javascript');
    expect(r.body).toContain('export const ui = 1;');
  });

  it('404s /sched-ui.bundle.js when the bundle file is missing', () => {
    const r = res();
    serveStatic('/sched-ui.bundle.js', asServer(r), { uiBundlePath: join(tmpdir(), 'does-not-exist.js') });
    expect(r.status).toBe(404);
    expect(r.body).toContain('not found');
  });

  it('serves the morda index at /', () => {
    const r = res();
    serveStatic('/', asServer(r));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain('sched-runs');
  });

  it('rejects path traversal outside staticDir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-ui-'));
    const r = res();
    serveStatic('/../secret', asServer(r), { staticDir: dir });
    expect(r.status).toBe(403);
  });
});

describe('mordaHtml', () => {
  it('defaults to /api mount and the local bundle', () => {
    const html = mordaHtml();
    expect(html).toContain("apiBase: '/api'");
    expect(html).toContain("from '/sched-ui.bundle.js'");
  });

  it('honours apiBase and bundleSrc (embedded-at-a-path mode)', () => {
    const html = mordaHtml({ apiBase: '/sched/api', bundleSrc: '/sched/sched-ui.bundle.js' });
    expect(html).toContain("apiBase: '/sched/api'");
    expect(html).toContain("from '/sched/sched-ui.bundle.js'");
  });

  it('has the token box and defines components before mounting', () => {
    const html = mordaHtml();
    expect(html).toContain('id="tokenInput"');
    expect(html).toContain('localStorage.getItem(tokenKey)');
    // components must know base/token before connect — define + applyConfig precede appendChild
    const defineIdx = html.indexOf('defineSchedElements()');
    const mountIdx = html.indexOf('mount.appendChild');
    expect(defineIdx).toBeGreaterThan(-1);
    expect(mountIdx).toBeGreaterThan(defineIdx);
  });

  it('wires ?refresh= through refreshFromSearch (0 disables polling, no || fallback)', () => {
    const html = mordaHtml();
    expect(html).toContain('refreshFromSearch(location.search, cfg.refreshMs)');
    expect(html).toContain('refreshFromSearch');
  });

  it('renders a page footer with version, api base and GitHub link', () => {
    const html = mordaHtml({ apiBase: '/sched/api' });
    expect(html).toContain('<footer>');
    expect(html).toContain('api <code>/sched/api</code>');
    expect(html).toContain('https://github.com/schedjs');
    // version comes from the package manifest (dist/../package.json)
    expect(html).toMatch(/v\d+\.\d+\.\d+/);
    // the daemon version is fetched from /health and shown in the footer
    expect(html).toContain('/health');
  });

  it('widens the main container so the 8-column schedules table fits (r8 U2)', () => {
    const html = mordaHtml();
    expect(html).toMatch(/main \{ padding:24px; max-width:1280px;/);
  });
});

describe('refreshFromSearch (?refresh= parsing — F&F r3 admin note)', () => {
  it('absent param → fallback', () => {
    expect(refreshFromSearch('', 5000)).toBe(5000);
    expect(refreshFromSearch('?api=/sched/api', 5000)).toBe(5000);
  });
  it('?refresh=0 stays 0 (polling off — 0 must not fall back to default)', () => {
    // regression: 0 || 5000 → 5000 (Number('0')=0 is falsy) — the admin's point-4 bug
    expect(refreshFromSearch('?refresh=0', 5000)).toBe(0);
  });
  it('?refresh=N parses the number', () => {
    expect(refreshFromSearch('?refresh=2500', 5000)).toBe(2500);
    expect(refreshFromSearch('?refresh=10000', 5000)).toBe(10000);
  });
  it('non-numeric value → fallback, not NaN', () => {
    expect(refreshFromSearch('?refresh=abc', 5000)).toBe(5000);
  });
});
