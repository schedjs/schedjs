#!/usr/bin/env node
/**
 * sched-ui serve — standalone admin UI.
 *
 * Serves the morda (html shell) + the component bundle and proxies /api/*
 * to a sched admin api (daemon `--admin-port` or an embedded createAdminApi).
 * Same-origin via the proxy: no CORS setup, the Bearer token never leaves the
 * browser->sched-ui hop.
 *
 *   sched-ui serve --proxy http://127.0.0.1:8080 --port 8081
 */
import { createReadStream, existsSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { DEFAULT_UI_BUNDLE, mordaHtml } from './morda.js';

export interface ServeOptions {
  /** Listen port. Default: 8081. */
  port?: number;
  /** Listen host. Default: 127.0.0.1. */
  host?: string;
  /** Upstream sched admin api origin (scheme://host:port). Default: http://127.0.0.1:8080. */
  proxy?: string;
  /** Morda apiBase (the /api mount the morda talks to). Default: /api. */
  apiBase?: string;
  /** Bundle file to serve at /sched-ui.bundle.js. Default: this package's dist build. */
  uiBundlePath?: string;
}

function buildHandler(
  opts: Required<Omit<ServeOptions, 'port' | 'host' | 'uiBundlePath'>> & Pick<ServeOptions, 'uiBundlePath'>,
) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(mordaHtml({ apiBase: opts.apiBase }));
      return;
    }

    if (path === '/sched-ui.bundle.js') {
      const bundle = opts.uiBundlePath ?? DEFAULT_UI_BUNDLE;
      if (existsSync(bundle)) {
        // The bundle is mutable (rebuilt on every @schedjs/ui release, no content-hash
        // in the filename) — a cached copy shows a stale UI, so never store it.
        res.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
        });
        createReadStream(bundle).pipe(res);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('sched-ui.bundle.js not found — build @schedjs/ui');
      return;
    }

    if (path === '/api' || path.startsWith('/api/')) {
      // proxy to the upstream admin api (path + query verbatim)
      const upstream = new URL(path + url.search, opts.proxy);
      const preq = request(
        upstream,
        {
          method: req.method ?? 'GET',
          headers: { ...req.headers, host: upstream.host },
        },
        (pres) => {
          // `/api/*` is live control-plane data — force revalidation so the browser
          // never shows a cached snapshot of a running task.
          res.writeHead(pres.statusCode ?? 502, {
            ...pres.headers,
            'cache-control': 'no-cache',
          });
          pres.pipe(res);
        },
      );
      preq.on('error', (err: Error) => {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`sched-ui: proxy error: ${err.message}`);
      });
      req.pipe(preq);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  };
}

export function createServe(opts: ServeOptions = {}) {
  const proxy = opts.proxy ?? process.env.SCHED_UI_PROXY ?? 'http://127.0.0.1:8080';
  const apiBase = opts.apiBase ?? '/api';
  const handler = buildHandler({
    proxy,
    apiBase,
    ...(opts.uiBundlePath !== undefined ? { uiBundlePath: opts.uiBundlePath } : {}),
  });
  const server = createServer(handler);
  return {
    server,
    listen: () =>
      new Promise<number>((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(opts.port ?? 8081, opts.host ?? '127.0.0.1', () => {
          const addr = server.address();
          resolveListen(typeof addr === 'object' && addr ? addr.port : opts.port ?? 8081);
        });
      }),
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

function main(argv: string[]): void {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a !== undefined && a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args.set(key, next);
        i++;
      } else {
        args.set(key, 'true');
      }
    }
  }
  if (args.has('help')) {
    console.log(`sched-ui serve — standalone admin UI for sched

Usage:
  sched-ui serve [--port 8081] [--host 127.0.0.1] [--proxy http://127.0.0.1:8080]

  --proxy   upstream sched admin api origin (daemon --admin-port, or an
            embedded createAdminApi). Default: http://127.0.0.1:8080 (env SCHED_UI_PROXY)
  --port    listen port. Default: 8081
  --host    listen host. Default: 127.0.0.1
`);
    return;
  }
  const proxy = args.get('proxy') ?? process.env.SCHED_UI_PROXY ?? 'http://127.0.0.1:8080';
  const port = Number(args.get('port') ?? 8081);
  const host = args.get('host') ?? '127.0.0.1';
  const serve = createServe({ port, host, proxy });
  void serve.listen().then((actual) => {
    console.log(`sched-ui morda on http://${host}:${actual} (api → ${proxy})`);
  });
}

// run as a bin (`node dist/serve.js …` or the `sched-ui` bin)
const invokedAsMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) main(process.argv.slice(2));
