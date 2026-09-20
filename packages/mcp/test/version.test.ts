import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/index.js';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { version: string };

describe('VERSION', () => {
  // issue:118 — баннер `sched-mcp v…` расходился с манифестом (хардкод 0.2.0 при
  // пакете 0.5.1). Инвариант: версия приходит из одного источника — package.json.
  it('совпадает с version манифеста', () => {
    expect(VERSION).toBe(pkg.version);
  });
});
