import { describe, expect, it } from 'vitest';
import { expectedArtifacts, parseNpmViewVersion, verify } from './publish-check-lib.mjs';

const PACKAGES = [
  { name: '@schedjs/core', version: '0.51.0' },
  { name: '@schedjs/daemon', version: '0.11.3' },
  { name: '@schedjs/admin-api', version: '0.3.0' },
  { name: '@schedjs/cli', version: '0.1.2' },
  { name: '@schedjs/mcp', version: '0.4.1' },
  { name: '@schedjs/ui', version: '0.3.0' },
  { name: '@schedjs/storage-mongo', version: '0.5.0' },
  { name: '@schedjs/storage-mysql', version: '0.4.0' },
  { name: '@schedjs/storage-postgres', version: '0.4.0' },
];

describe('publish-check expectedArtifacts', () => {
  it('derives npm artifacts (name + version) and the daemon image tag from workspace packages', () => {
    const arts = expectedArtifacts(PACKAGES, { daemonImage: 'ghcr.io/schedjs/sched-daemon' });
    expect(arts.npm).toHaveLength(9);
    expect(arts.npm[0]).toEqual({ name: '@schedjs/admin-api', version: '0.3.0' });
    expect(arts.npm.find((a) => a.name === '@schedjs/core')).toEqual({ name: '@schedjs/core', version: '0.51.0' });
    expect(arts.docker).toEqual([{ image: 'ghcr.io/schedjs/sched-daemon', tag: '0.11.3' }]);
  });

  it('skips packages without a version (private / unpublished workspaces)', () => {
    const withPrivate = [...PACKAGES, { name: '@schedjs/private-tool', version: undefined }];
    const arts = expectedArtifacts(withPrivate, { daemonImage: 'img' });
    expect(arts.npm.find((a) => a.name === '@schedjs/private-tool')).toBeUndefined();
  });
});

describe('publish-check parseNpmViewVersion', () => {
  it('parses a clean npm view output line', () => {
    expect(parseNpmViewVersion('0.51.0\n', '@schedjs/core')).toBe('0.51.0');
  });

  it('returns undefined for empty output (not landed)', () => {
    expect(parseNpmViewVersion('', '@schedjs/core')).toBeUndefined();
  });

  it('returns undefined for npm error output', () => {
    expect(parseNpmViewVersion('npm error code E404\nnpm error Not Found\n', '@schedjs/core')).toBeUndefined();
  });
});

describe('publish-check verify', () => {
  it('reports all landed when every artifact resolves to its expected version', () => {
    const verdict = verify(
      { npm: [{ name: '@schedjs/core', version: '0.51.0' }], docker: [] },
      { npm: { '@schedjs/core': '0.51.0' }, docker: {} },
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.missing).toEqual([]);
  });

  it('flags a package whose registry version differs (the 0.11.2 twice-failed case)', () => {
    const verdict = verify(
      { npm: [{ name: '@schedjs/daemon', version: '0.11.3' }], docker: [] },
      { npm: { '@schedjs/daemon': '0.11.2' }, docker: {} },
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toEqual([{ kind: 'npm', name: '@schedjs/daemon', expected: '0.11.3', got: '0.11.2' }]);
  });

  it('flags an unlanded image (docker manifest inspect failed)', () => {
    const verdict = verify(
      { npm: [], docker: [{ image: 'ghcr.io/schedjs/sched-daemon', tag: '0.11.3' }] },
      { npm: {}, docker: {} },
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toEqual([{ kind: 'docker', image: 'ghcr.io/schedjs/sched-daemon', tag: '0.11.3' }]);
  });
});
