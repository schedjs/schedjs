import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Parity gate for the docs reference examples. The "Build your own adapter" /
 * "Custom runners" pages embed full reference implementations (MemoryStorage,
 * createFileRunner); those code fences must stay byte-identical to the real
 * sources in test/helpers — a doc example that drifts is a lie, and this repo's
 * docs promise is "test-pinned, not assumed". A drift (either direction) fails
 * the suite.
 */
const DOCS = fileURLToPath(new URL('../../../docs/content/docs/', import.meta.url));
const HELPERS = fileURLToPath(new URL('./helpers/', import.meta.url));

function extractFence(mdPath: string, marker: string): string {
  const md = readFileSync(mdPath, 'utf8');
  const fences = [...md.matchAll(/```ts\n([\s\S]*?)```/g)];
  const hit = fences.find((m) => m[1]!.includes(marker));
  if (!hit) throw new Error(`no \`\`\`ts fence containing "${marker}" in ${mdPath}`);
  return hit[1]!.replace(/\n$/, '');
}

const sourceOf = (name: string) => readFileSync(`${HELPERS}${name}`, 'utf8').replace(/\n$/, '');

describe('docs reference examples stay in sync with test/helpers sources', () => {
  it('MemoryStorage (07.storage/custom/01.memory-storage.md) is byte-identical to helpers/memory-storage.ts', () => {
    const embedded = extractFence(`${DOCS}07.storage/custom/01.memory-storage.md`, 'export class MemoryStorage');
    expect(embedded).toBe(sourceOf('memory-storage.ts'));
  });

  it('createFileRunner (06.runners/custom/01.file-runner.md) is byte-identical to helpers/file-runner.ts', () => {
    const embedded = extractFence(`${DOCS}06.runners/custom/01.file-runner.md`, 'export function createFileRunner');
    expect(embedded).toBe(sourceOf('file-runner.ts'));
  });
});
