// Sync packages/admin-api/openapi.json → docs/public/openapi.json.
//
// The docs site serves the spec at https://schedjs.com/openapi.json so
// clients can download it without running the API or touching npm. The
// package spec is the single source of truth (route-parity-tested against
// the router); this copy is byte-identical by construction and guarded by
// packages/admin-api/test/ts-client-guard.test.ts (docs-site copy check).
//
// Runs as a pre-step of every docs build (build/generate/dev in
// docs/package.json) — a stale public copy is impossible as long as builds
// go through the npm scripts.
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgSpec = join(here, '..', 'packages', 'admin-api', 'openapi.json');
const docsPublic = join(here, 'public');

mkdirSync(docsPublic, { recursive: true });
copyFileSync(pkgSpec, join(docsPublic, 'openapi.json'));
console.log('openapi.json → docs/public/openapi.json (byte-identical copy)');
