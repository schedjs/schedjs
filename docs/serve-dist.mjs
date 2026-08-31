// serve-dist.mjs — preview the committed docs/dist (the GitHub Pages artifact)
// locally, including the /schedjs/ base path the Pages site runs under.
//
// Why: `nuxi preview` serves .output (the build workspace), not docs/dist —
// the real artifact that gets committed and deployed. This script serves
// dist/ verbatim so a change to the Pages output is reviewable before push.
//
// Usage: node serve-dist.mjs [port]   (default 8080)
//   http://127.0.0.1:8080/schedjs/docs/introduction
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = '/schedjs/';
const DIST = fileURLToPath(new URL('./dist', import.meta.url));
const PORT = Number(process.argv[2] ?? 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  // root → the Pages home redirect (matches docs-dist.mjs post-process)
  if (pathname === '/') {
    res.writeHead(302, { location: `${BASE}docs/introduction` });
    res.end();
    return;
  }
  // strip the /schedjs/ base; anything else 404s like the real Pages host
  if (!pathname.startsWith(BASE)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end(`not found (this site is served under ${BASE})`);
    return;
  }
  let rel = pathname.slice(BASE.length);
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const base = resolve(DIST, normalize(rel));
  // GitHub Pages resolution: exact file → sibling .html → index.html — a Nuxt
  // route /docs/whats-new maps to whats-new.html on disk
  const candidates = [base, `${base}.html`, join(base, 'index.html')];
  const file = candidates.find((p) => p.startsWith(DIST) && existsSync(p) && statSync(p).isFile());
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`docs/dist preview → http://127.0.0.1:${PORT}${BASE}docs/introduction`);
});
