import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';

import { refreshFromSearch } from './refresh.js';

export { refreshFromSearch };

/** @schedjs/ui version, read from the package manifest at runtime (dist/../package.json). */
const UI_VERSION = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '';
  } catch {
    return '';
  }
})();

/**
 * The sched admin morda — the standalone HTML shell that mounts the sched web
 * components (this package, bundled into sched-ui.bundle.js) against an admin
 * api at `apiBase`.
 *
 * Consumption modes:
 *  1. standalone — `sched-ui serve` (see serve.ts) proxies /api to a daemon;
 *  2. embedded at a path — host dist/ statically under /sched, apiBase="/sched/api";
 *  3. components only — drop <sched-runs base=… token=…> into your own page;
 *  4. custom UI — build on createAdminApi from @schedjs/core.
 *
 * Theming: all components + the morda are styled via CSS custom properties
 * (--sched-*); override them in your own stylesheet.
 */
export interface MordaOptions {
  /** Mount path of the sched admin api. Default: /api (same origin). */
  apiBase?: string;
  /** localStorage key for the optional Bearer token. Default: sched-token. */
  tokenKey?: string;
  /** Auto-refresh interval for every list (runs/tasks/schedules), ms. Default: 5000. */
  refreshMs?: number;
  /** URL of the bundle script in the html. Default: /sched-ui.bundle.js. */
  bundleSrc?: string;
}

/**
 * Effective auto-refresh interval from a `?refresh=` query value.
 * - absent or non-numeric → `fallback`
 * - `0` stays `0` (polling off — 0 is a valid number, must not fall back)
 *   (F&F r3: `Number('0') || fallback` was falling through to the default.)
 */
export function mordaHtml(options: MordaOptions = {}): string {
  const apiBase = options.apiBase ?? '/api';
  const tokenKey = options.tokenKey ?? 'sched-token';
  const refreshMs = options.refreshMs ?? 5000;
  const bundleSrc = options.bundleSrc ?? '/sched-ui.bundle.js';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sched — cron done right</title>
<style>
  :root { color-scheme: dark; --sched-bg:#0f1115; --sched-card:#171a21; --sched-line:#2a2f3a; --sched-text:#e6e8ee; --sched-muted:#9aa3b2; --sched-ok:#3fb950; --sched-bad:#f85149; --sched-run:#58a6ff; }
  * { box-sizing: border-box; }
  body { margin:0; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background:var(--sched-bg); color:var(--sched-text); }
  header { display:flex; align-items:center; gap:12px; padding:12px 24px; border-bottom:1px solid var(--sched-line); }
  header h1 { font-size:16px; margin:0; } header .dot { width:8px; height:8px; border-radius:50%; background:var(--sched-ok); }
  header .spacer { flex:1; }
  .token-box { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--sched-muted); }
  .token-box input { background:var(--sched-bg); border:1px solid var(--sched-line); color:var(--sched-text); border-radius:6px; padding:4px 8px; font:inherit; font-size:12px; width:180px; }
  .token-box .hint { cursor:pointer; }
  main { padding:24px; max-width:1280px; margin:0 auto; display:flex; flex-direction:column; gap:24px; }
  section { background:var(--sched-card); border:1px solid var(--sched-line); border-radius:8px; padding:16px; }
  footer { display:flex; align-items:center; gap:12px; padding:12px 24px; border-top:1px solid var(--sched-line); color:var(--sched-muted); font-size:12px; }
  footer .spacer { flex:1; }
  footer code { background:var(--sched-card); border:1px solid var(--sched-line); border-radius:4px; padding:1px 6px; font:inherit; }
  footer a { color:var(--sched-run); text-decoration:none; }
  footer a:hover { text-decoration:underline; }
</style>
</head>
<body>
<header>
  <span class="dot"></span><h1>sched</h1>
  <span class="spacer"></span>
  <div class="token-box" id="tokenBox" hidden>
    <label for="tokenInput">token</label>
    <input id="tokenInput" type="password" placeholder="SCHED_ADMIN_KEY" autocomplete="off">
    <span class="hint" id="tokenSave" title="save token">&#128190;</span>
  </div>
</header>
<main id="mount"></main>
<footer>
  <span>sched <span class="ver">${UI_VERSION ? `v${UI_VERSION}` : ''}</span></span>
  <span id="daemonVer"></span>
  <span>cron done right</span>
  <span class="spacer"></span>
  <span>api <code>${apiBase}</code></span>
  <a href="https://github.com/schedjs" target="_blank" rel="noopener">GitHub</a>
</footer>
<script type="module">
  import { defineSchedElements, refreshFromSearch } from '${bundleSrc}';

  // defaults (overridable at runtime via query params)
  const cfg = { apiBase: '${apiBase}', tokenKey: '${tokenKey}', refreshMs: ${refreshMs} };
  const apiBase = new URLSearchParams(location.search).get('api') || cfg.apiBase;
  const tokenKey = cfg.tokenKey;
  const refreshMs = refreshFromSearch(location.search, cfg.refreshMs);

  // runtime override: ?token= wins, otherwise localStorage
  let token = new URLSearchParams(location.search).get('token') || '';
  if (!token && tokenKey) {
    try { token = localStorage.getItem(tokenKey) || ''; } catch { /* private mode */ }
  }

  // build components (not yet connected — no fetch on connect until configured)
  const specs = [
    ['sched-runs', { limit: '50' }],
    ['sched-tasks', {}],
    ['sched-schedules', {}],
  ];
  const created = specs.map(([tag, attrs]) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    const section = document.createElement('section');
    section.appendChild(el);
    return { section, el };
  });
  const components = () => created.map((c) => c.el);

  function applyConfig() {
    for (const el of components()) {
      el.base = apiBase;
      el.token = token || undefined;
      el.refreshMs = refreshMs;
    }
  }

  // define + configure BEFORE mounting — components fetch on connect, so they
  // must already know base/token (otherwise the first load goes out unauthenticated)
  defineSchedElements();
  applyConfig();
  const mount = document.getElementById('mount');
  for (const { section } of created) mount.appendChild(section);

  // token field (only shown when no token is known yet)
  const box = document.getElementById('tokenBox');
  const input = document.getElementById('tokenInput');
  const save = document.getElementById('tokenSave');
  if (token) {
    input.value = token;
  } else {
    box.hidden = false; // prompt for a token — api may be open, but be ready
  }
  save.addEventListener('click', () => {
    const v = input.value.trim();
    try {
      if (v) localStorage.setItem(tokenKey, v);
      else localStorage.removeItem(tokenKey);
    } catch { /* private mode */ }
    token = v;
    applyConfig();
    for (const c of components()) void c.load?.();
  });

  // daemon version in the footer, from /health (best-effort — footer stays
  // without it when the api is unreachable or the field is absent)
  const daemonVer = document.getElementById('daemonVer');
  if (daemonVer) {
    const headers = token ? { authorization: 'Bearer ' + token } : {};
    fetch(apiBase + '/health', { headers })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (b && b.version) daemonVer.textContent = '· daemon v' + b.version;
      })
      .catch(() => {});
  }
</script>
</body>
</html>
`;
}

/** The built component bundle — lives next to this module in dist/. */
export const DEFAULT_UI_BUNDLE = fileURLToPath(new URL('./sched-ui.bundle.js', import.meta.url));

export interface StaticOptions {
  /** Root directory for /… paths (optional). */
  staticDir?: string;
  /** Path to the bundled sched-ui file served at /sched-ui.bundle.js. */
  uiBundlePath?: string;
  /** Morda apiBase. Default: /api. */
  apiBase?: string;
  /** Morda bundleSrc. Default: /sched-ui.bundle.js. */
  bundleSrc?: string;
}

export function serveStatic(reqPath: string, res: ServerResponse, opts: StaticOptions = {}): void {
  const path = reqPath === '/' ? '/index.html' : reqPath;

  // web-components bundle — the morda depends on it; serve from uiBundlePath
  // (default: this package's dist build).
  if (path === '/sched-ui.bundle.js') {
    const bundle = opts.uiBundlePath ?? DEFAULT_UI_BUNDLE;
    if (existsSync(bundle) && statSync(bundle).isFile()) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      createReadStream(bundle).pipe(res);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('sched-ui.bundle.js not found — build @schedjs/ui (yarn workspace @schedjs/ui build)');
    return;
  }

  if (opts.staticDir) {
    // resolve inside the root — reject path traversal
    const root = resolve(opts.staticDir);
    const resolved = normalize(resolve(root, '.' + path));
    const rel = relative(root, resolved);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    if (existsSync(resolved) && statSync(resolved).isFile()) {
      res.writeHead(200, { 'content-type': contentType(resolved) });
      createReadStream(resolved).pipe(res);
      return;
    }
  }

  if (path === '/index.html') {
    const mordaOpts: MordaOptions = {};
    if (opts.apiBase !== undefined) mordaOpts.apiBase = opts.apiBase;
    if (opts.bundleSrc !== undefined) mordaOpts.bundleSrc = opts.bundleSrc;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(mordaHtml(mordaOpts));
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

function contentType(path: string): string {
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}
