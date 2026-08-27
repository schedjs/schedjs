// Remove build output dirs before tsc. tsc never deletes compiled modules whose
// source was removed, so stale artifacts (modules extracted to their own
// packages) silently leak into the published tarball — verified on
// @schedjs/core@0.41.0 (dist/admin-api.*, dist/mongo.*, dist/mysql.*,
// dist/postgres.* in the tarball).
//
// Usage: node scripts/clean.mjs [dir...]   (default: dist, relative to cwd)
// Every package build script runs it first: `node ../../scripts/clean.mjs && tsc …`
import { rmSync } from 'node:fs';

const dirs = process.argv.slice(2);
if (dirs.length === 0) dirs.push('dist');

for (const dir of dirs) {
  rmSync(dir, { recursive: true, force: true });
}
