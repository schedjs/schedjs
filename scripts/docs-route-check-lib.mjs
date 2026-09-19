// docs-route-check-lib.mjs — pure helpers behind scripts/docs-route-check.mjs.
//
// Docus (Nuxt Content) derives a page route from the file path by stripping
// the `NN.` ordering prefix from every segment, so `05.protocol.md` and
// `06.protocol.md` both resolve to /docs/protocol. Two source files on one
// route is always a bug: one page silently wins and the sidebar lists the
// entry twice. That is exactly what shipped to
// https://schedjs.github.io/schedjs/docs/protocol on 2026-09-19 — a curated
// dev→public sync added the renumbered doc set without removing the old one.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** `NN.` ordering prefix — Docus drops it when building the route. */
const ORDER_PREFIX = /^\d+\./;

/** Drop the Docus ordering prefix from one path segment. */
export function stripOrderPrefix(segment) {
  return segment.replace(ORDER_PREFIX, '');
}

/**
 * Route (without the `/docs` base) that Docus serves a content file on.
 * `08.storage/01.adapters/01.sqlite.md` → `storage/adapters/sqlite`
 * `08.storage/index.md` → `storage`
 */
export function routeFor(relPath) {
  const segments = relPath.split('/').filter(Boolean);
  const last = segments.pop();
  if (last === undefined) return '';
  const dirs = segments.map(stripOrderPrefix);
  if (last === 'index.md') return dirs.join('/');
  return [...dirs, stripOrderPrefix(last.replace(/\.md$/, ''))].join('/');
}

/** Routes claimed by more than one source file — `[{ route, files }]`, stable order. */
export function findRouteCollisions(relPaths) {
  const byRoute = new Map();
  for (const relPath of relPaths) {
    const route = routeFor(relPath);
    const files = byRoute.get(route);
    if (files) files.push(relPath);
    else byRoute.set(route, [relPath]);
  }
  return [...byRoute.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([route, files]) => ({ route, files: [...files].sort() }));
}

function walk(dir, prefix, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(join(dir, entry.name), relPath, out);
    else out.push(relPath);
  }
}

/**
 * Scan a content dir: Map<route, relPaths[]> (POSIX separators, sorted).
 * Only markdown content is considered — `.navigation.yml` and friends are
 * not routes.
 */
export function scanDocsRoutes(dir) {
  const files = [];
  walk(dir, '', files);

  const routes = new Map();
  for (const relPath of files.filter((f) => f.endsWith('.md')).sort()) {
    const route = routeFor(relPath);
    const bucket = routes.get(route);
    if (bucket) bucket.push(relPath);
    else routes.set(route, [relPath]);
  }
  return routes;
}
