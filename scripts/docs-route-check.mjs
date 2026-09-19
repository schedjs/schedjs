// docs-route-check.mjs — fail if two content files claim the same Docus route.
//
// `NN.` prefixes order the sidebar but do NOT disambiguate URLs: Docus strips
// them, so `05.protocol.md` and `06.protocol.md` are both /docs/protocol.
// A renumbered-but-not-pruned doc tree (dev→public curated sync, 2026-09-19)
// therefore deployed a sidebar with every entry twice. Run this before
// building docs (CI step) and after syncing dev → public.
//
// Usage:
//   node scripts/docs-route-check.mjs [contentDir]   (default: docs/content/docs)
// Exit 1 + the colliding routes, or exit 0 with a page count.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRouteCollisions, scanDocsRoutes } from './docs-route-check-lib.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const contentDir = process.argv[2]
  ? resolve(process.argv[2])
  : join(ROOT, 'docs', 'content', 'docs');

if (!existsSync(contentDir)) {
  console.error(`docs-route-check: content dir not found: ${contentDir}`);
  process.exit(1);
}

const routes = scanDocsRoutes(contentDir);
const collisions = findRouteCollisions([...routes.values()].flat());

if (collisions.length > 0) {
  console.error(
    `docs-route-check: ${collisions.length} route(s) claimed by more than one file in ${contentDir}\n` +
      'Docus strips the NN. prefix — two copies = one page silently wins, the sidebar lists it twice.\n' +
      'Delete the stale copy (usually the old ordering number left behind by a dev→public sync).\n',
  );
  for (const { route, files } of collisions) {
    console.error(`  /docs/${route}`);
    for (const file of files) console.error(`    - ${file}`);
  }
  process.exit(1);
}

console.log(`docs-route-check: ok — ${routes.size} page(s), no duplicate routes`);
