import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  main?: string;
  exports?: Record<string, { import?: string; types?: string }>;
  name: string;
};

// Regression (F&F-01): `import { createDaemon } from '@schedjs/daemon'` failed with
// ERR_MODULE_NOT_FOUND because the package had no main/exports map. The docs'
// first custom-runner example broke on this.
describe('@schedjs/daemon package exports', () => {
  it('declares main + exports so the package root resolves to dist/daemon.js', () => {
    expect(PKG.main).toBe('./dist/daemon.js');
    expect(PKG.exports?.['.']?.import).toBe('./dist/daemon.js');
    expect(PKG.exports?.['.']?.types).toBe('./dist/daemon.d.ts');
  });

  it('node resolves `@schedjs/daemon` (self-reference) to a working createDaemon', () => {
    const fixture = fileURLToPath(new URL('./fixtures/exports-smoke.mjs', import.meta.url));
    const out = execSync(`node "${fixture}"`, {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
    });
    expect(out.trim()).toBe('function');
  });
});
