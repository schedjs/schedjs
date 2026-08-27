import { defineConfig } from 'vitest/config';

// CI-only vitest config: the full suite includes storage adapters that need
// live databases (Postgres/MySQL/MariaDB/Mongo — docker services). On CI we
// run the unit suite only; the storage contract + env-helper suites run
// locally (Windows + docker) and at release time.
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'scripts/*.test.mjs'],
    exclude: ['**/node_modules/**', '**/dist/**', 'packages/storage-*/test/**'],
  },
});
