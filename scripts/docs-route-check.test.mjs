// RED-first spec for docs-route-check (scripts/docs-route-check-lib.mjs).
//
// Why this exists: the 2026-09-19 publish wave (public repo schedjs/schedjs)
// renumbered docs/content/docs/*.md in dev (03.quick-start, 06.protocol, …)
// and the curated sync ADDED the new files without DELETING the old ones
// (02.quick-start, 05.protocol, 06.runners/, 07.storage/, …). Docus maps a
// file to its route by stripping the `NN.` ordering prefix, so both copies
// resolve to the SAME URL: the deployed sidebar listed every page twice.
//
// The guard: compute routes from filenames and fail on any route that more
// than one source file maps to. Run before the docs build (CI) and before
// syncing dev → public.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findRouteCollisions, routeFor, scanDocsRoutes } from './docs-route-check-lib.mjs';

describe('routeFor', () => {
  it('strips the NN. ordering prefix from every path segment', () => {
    expect(routeFor('08.storage/01.adapters/01.sqlite.md')).toBe('storage/adapters/sqlite');
  });

  it('maps NN.dir/index.md onto the directory route', () => {
    expect(routeFor('08.storage/index.md')).toBe('storage');
  });

  it('keeps an unprefixed filename as-is', () => {
    expect(routeFor('admin-api.md')).toBe('admin-api');
  });
});

describe('findRouteCollisions', () => {
  it('reports nothing for a clean tree', () => {
    expect(findRouteCollisions(['05.runs.md', '06.protocol.md'])).toEqual([]);
  });

  it('catches the same page sitting under two order numbers (the publish bug)', () => {
    const collisions = findRouteCollisions(['05.protocol.md', '06.protocol.md']);
    expect(collisions).toHaveLength(1);
    expect(collisions[0].route).toBe('protocol');
    expect([...collisions[0].files].sort()).toEqual(['05.protocol.md', '06.protocol.md']);
  });

  it('catches a whole duplicated subtree', () => {
    const collisions = findRouteCollisions(['06.runners/01.http.md', '07.runners/01.http.md']);
    expect(collisions.map((c) => c.route)).toEqual(['runners/http']);
  });

  it('keeps a directory index and its siblings as distinct routes', () => {
    expect(findRouteCollisions(['08.storage/index.md', '08.storage/09.custom.md'])).toEqual([]);
  });
});

describe('scanDocsRoutes', () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('walks the tree, ignores non-markdown, normalises separators', () => {
    dir = mkdtempSync(join(tmpdir(), 'docs-routes-'));
    mkdirSync(join(dir, '07.runners'), { recursive: true });
    writeFileSync(join(dir, '07.runners', '01.http.md'), '# http');
    writeFileSync(join(dir, '07.runners', '.navigation.yml'), 'title: Runners');

    const routes = scanDocsRoutes(dir);

    expect([...routes.keys()]).toEqual(['runners/http']);
    expect(routes.get('runners/http')).toEqual(['07.runners/01.http.md']);
  });
});
