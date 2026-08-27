import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url)); // packages/core
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

function walk(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

/**
 * Stale-artifact regression (clean-build-stale-dist, 2026-08-18): tsc never
 * deletes compiled modules whose source was removed, so a module extracted to
 * its own package (admin-api, mongo, mysql, postgres) kept shipping inside the
 * @schedjs/core tarball — confirmed via `yarn pack --dry-run` on 0.41.0.
 *
 * Guard: every compiled module in dist/ must have a live source in src/.
 * The build step cleans dist before tsc; this test pins the invariant so a
 * future extraction can't silently resurrect the bug.
 */
describe('@schedjs/core dist hygiene', () => {
  it.skipIf(!existsSync(DIST))(
    'dist contains no compiled module whose source was removed',
    () => {
      const srcModules = new Set(
        walk(SRC)
          .filter((f) => f.endsWith('.ts'))
          .map((f) => f.replace(/\.ts$/, '')),
      );
      const distModules = walk(DIST)
        .filter((f) => f.endsWith('.js'))
        .map((f) => f.replace(/\.js$/, ''));
      const orphans = distModules.filter((m) => !srcModules.has(m));
      expect(orphans).toEqual([]);
    },
  );
});
