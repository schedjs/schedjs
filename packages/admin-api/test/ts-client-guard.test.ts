import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Second-flavor guard (ts-client-smoke task, 2026-08-18): the docs promise
 * "generate a client in any language" — the python suite proved ONE generator
 * (openapi-generator 7.24.0, python). The spec is OpenAPI 3.1 with 21 nullable
 * unions (`type: [...,"null"]`) whose support varies by generator flavor.
 * TypeScript (typescript-axios) is the highest-value second probe: the only
 * real consumer (books Phase 3) is Nuxt 4 / TS.
 *
 * Three guards:
 *  1. always-on — the pinned `openapi.json` copies in both examples
 *     (admin-client-python, admin-client-ts) AND the docs-site copy
 *     (docs/public/openapi.json, served at https://schedjs.com/openapi.json)
 *     must stay byte-identical to packages/admin-api/openapi.json. A spec edit
 *     that forgets to re-pin / re-sync fails the suite.
 *  2. opt-in (`RUN_TS_SMOKE=1`) — fresh openapi-generator (typescript-axios)
 *     run + `tsc --noEmit` on the output must exit 0. Needs JDK 11+ and
 *     network (npx / npm); skipped when java is unavailable. CI can set the
 *     env var to enable the deep guard.
 */
const PKG_SPEC = readFileSync(fileURLToPath(new URL('../openapi.json', import.meta.url)), 'utf8');
const TS_SPEC_PATH = fileURLToPath(new URL('../../../examples/admin-client-ts/openapi.json', import.meta.url));
const PY_SPEC_PATH = fileURLToPath(new URL('../../../examples/admin-client-python/openapi.json', import.meta.url));
const DOCS_SPEC_PATH = fileURLToPath(new URL('../../../docs/public/openapi.json', import.meta.url));
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function javaMajor(): number | null {
  const r = spawnSync('java', ['-version'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const out = (r.stderr || r.stdout || '');
  const m = out.match(/(?:version "|openjdk version ")([^"]+)/);
  if (!m) return null;
  const v = m[1];
  if (!v) return null;
  // "1.8.0_502" → 8 ; "25.0.2" → 25
  return v.startsWith('1.') ? Number(v.split('.')[1]) : Number(v.split('.')[0]);
}

describe('openapi pinned copies (always-on)', () => {
  it('example pinned specs are byte-identical to the package spec', () => {
    const tsSpec = readFileSync(TS_SPEC_PATH, 'utf8');
    const pySpec = readFileSync(PY_SPEC_PATH, 'utf8');
    expect(tsSpec).toBe(PKG_SPEC);
    expect(pySpec).toBe(PKG_SPEC);
  });

  it('docs-site copy is byte-identical to the package spec', () => {
    // docs/public/openapi.json is synced from the package spec by
    // docs/sync-openapi.mjs (pre-build step in docs/package.json). A spec edit
    // that forgets to re-sync fails here — the site would serve a stale spec.
    const docsSpec = readFileSync(DOCS_SPEC_PATH, 'utf8');
    expect(docsSpec).toBe(PKG_SPEC);
  });
});

describe('TS client smoke (opt-in: RUN_TS_SMOKE=1)', () => {
  const run = process.env.RUN_TS_SMOKE === '1';
  it.skipIf(!run)('fresh generate (typescript-axios) + tsc --noEmit exits 0', { timeout: 300_000 }, () => {
    const major = javaMajor();
    if (major === null) {
      console.warn('TS client smoke: java not found — skipping');
      return;
    }
    if (major < 11) {
      // generator CLI is compiled for Java 11+; the JVM is picked from PATH,
      // not JAVA_HOME (see examples/admin-client-ts/generate.ps1)
      console.warn(`TS client smoke: java ${major} < 11 — skipping (put JDK 11+ bin on PATH)`);
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'sched-ts-smoke-'));
    try {
      const specPath = join(dir, 'openapi.json');
      writeFileSync(specPath, PKG_SPEC);

      const gen = spawnSync(
        'npx',
        ['--yes', '@openapitools/openapi-generator-cli', 'generate', '-i', specPath, '-g', 'typescript-axios', '-o', join(dir, 'out')],
        { cwd: ROOT, shell: process.platform === 'win32', encoding: 'utf8', timeout: 180_000 },
      );
      expect(gen.status, gen.stderr ?? gen.stdout).toBe(0);

      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'smoke', private: true, type: 'module' }));
      const install = spawnSync('npm', ['install', '--no-save', '--silent', '--no-audit', '--no-fund', 'axios', 'typescript'], {
        cwd: dir,
        shell: process.platform === 'win32',
        encoding: 'utf8',
        timeout: 180_000,
      });
      expect(install.status, install.stderr ?? install.stdout).toBe(0);

      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            esModuleInterop: true,
            types: [],
          },
          include: ['out/**/*.ts'],
        }),
      );

      const tsc = spawnSync('npx', ['tsc', '--noEmit', '-p', 'tsconfig.json'], {
        cwd: dir,
        shell: process.platform === 'win32',
        encoding: 'utf8',
        timeout: 180_000,
      });
      expect(tsc.status, tsc.stdout + (tsc.stderr ?? '')).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
