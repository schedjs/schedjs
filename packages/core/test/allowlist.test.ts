import { describe, expect, it } from 'vitest';
import {
  assertValidMcpToolSpecs,
  dockerToolAllowed,
  isSubsetOf,
  matchesPattern,
  parseDockerTool,
} from '../src/allowlist.js';

describe('allowlist — matchesPattern (unified exact + `*`-prefix)', () => {
  it('allows everything when the list is omitted or empty (opt-in security)', () => {
    expect(matchesPattern('node', undefined)).toBe(true);
    expect(matchesPattern('node', [])).toBe(true);
  });

  it('matches exact and trailing-* prefixes', () => {
    expect(matchesPattern('node', ['node'])).toBe(true);
    expect(matchesPattern('node', ['python*'])).toBe(false);
    expect(matchesPattern('python3', ['python*'])).toBe(true);
    expect(matchesPattern('python3.11', ['python*'])).toBe(true);
    expect(matchesPattern('alpine:latest', ['alpine:*'])).toBe(true);
    expect(matchesPattern('alpine:3.19', ['alpine:*'])).toBe(true);
    expect(matchesPattern('ubuntu', ['alpine:*'])).toBe(false);
    expect(matchesPattern('read_data', ['read_*'])).toBe(true);
    expect(matchesPattern('write_data', ['read_*'])).toBe(false);
  });

  it('`*` alone matches everything; leading wildcards are NOT supported (only trailing)', () => {
    expect(matchesPattern('anything', ['*'])).toBe(true);
    expect(matchesPattern('node', ['*node'])).toBe(false); // leading * is literal
  });
});

describe('allowlist — isSubsetOf (task tools ⊆ runner ceiling)', () => {
  it('passes when the task declares nothing or the ceiling is absent', () => {
    expect(isSubsetOf(undefined, undefined)).toBe(true);
    expect(isSubsetOf(['node'], undefined)).toBe(true);
    expect(isSubsetOf(undefined, ['node'])).toBe(true);
  });

  it('rejects a task tool that no ceiling pattern matches', () => {
    expect(isSubsetOf(['node'], ['python*'])).toBe(false);
    expect(isSubsetOf(['node', 'python3'], ['python*'])).toBe(false);
  });

  it('accepts a task tool covered by the ceiling', () => {
    expect(isSubsetOf(['node'], ['node'])).toBe(true);
    expect(isSubsetOf(['node', 'python3'], ['node', 'python*'])).toBe(true);
    expect(isSubsetOf(['alpine@echo'], ['alpine*'])).toBe(true);
  });
});

describe('allowlist — docker tool spec `image@cmd`', () => {
  it('parses image-only specs (no @)', () => {
    expect(parseDockerTool('alpine')).toEqual({ image: 'alpine' });
    expect(parseDockerTool('alpine:latest')).toEqual({ image: 'alpine:latest' }); // tag colon is NOT a separator
    expect(parseDockerTool('registry/x:1.2')).toEqual({ image: 'registry/x:1.2' });
  });

  it('parses image@cmd on the LAST @', () => {
    expect(parseDockerTool('alpine@echo')).toEqual({ image: 'alpine', command: 'echo' });
    expect(parseDockerTool('alpine@*')).toEqual({ image: 'alpine', command: '*' });
    expect(parseDockerTool('*@echo')).toEqual({ image: '*', command: 'echo' });
    expect(parseDockerTool('a@b@echo')).toEqual({ image: 'a@b', command: 'echo' });
  });

  it('dockerToolAllowed: image must match; a spec with a command requires the invocation to carry it', () => {
    const tools = ['alpine@echo', 'busybox'];
    expect(dockerToolAllowed('alpine', 'echo', tools)).toBe(true);
    expect(dockerToolAllowed('alpine', 'sh', tools)).toBe(false); // command mismatch
    expect(dockerToolAllowed('alpine', undefined, tools)).toBe(false); // spec wants echo, none given
    expect(dockerToolAllowed('busybox', 'anything', tools)).toBe(true); // busybox: any command
    expect(dockerToolAllowed('busybox', undefined, tools)).toBe(true);
    expect(dockerToolAllowed('ubuntu', 'echo', tools)).toBe(false);
  });

  it('dockerToolAllowed: empty/omitted list allows all (opt-in)', () => {
    expect(dockerToolAllowed('anything', 'any', undefined)).toBe(true);
    expect(dockerToolAllowed('anything', 'any', [])).toBe(true);
  });

  it('dockerToolAllowed: wildcards on either side', () => {
    expect(dockerToolAllowed('alpine:3.19', 'echo', ['alpine:*@echo'])).toBe(true);
    expect(dockerToolAllowed('ubuntu', 'echo', ['*@echo'])).toBe(true);
    expect(dockerToolAllowed('ubuntu', 'sh', ['*@echo'])).toBe(false);
  });
});

describe('allowlist — assertValidMcpToolSpecs (http server-only spec footgun)', () => {
  it('rejects a bare http spec without a tool dimension (silent no-match footgun)', () => {
    expect(() => assertValidMcpToolSpecs(['https://mcp.example.com'])).toThrow(/tool dimension/);
    expect(() => assertValidMcpToolSpecs(['http://mcp.example.com'])).toThrow(/tool dimension/);
  });

  it('rejects an http spec whose port is eaten into the tool dimension (host:port, no tool)', () => {
    expect(() => assertValidMcpToolSpecs(['https://127.0.0.1:1'])).toThrow(/tool dimension/);
    expect(() => assertValidMcpToolSpecs(['http://127.0.0.1:1'])).toThrow(/tool dimension/);
    expect(() => assertValidMcpToolSpecs(['https://mcp.example.com:8443'])).toThrow(/tool dimension/);
  });

  it('accepts explicit `url:*`, `url:tool`, and ported specs', () => {
    expect(() => assertValidMcpToolSpecs(['https://mcp.example.com:*'])).not.toThrow();
    expect(() => assertValidMcpToolSpecs(['https://mcp.example.com:read_*'])).not.toThrow();
    expect(() => assertValidMcpToolSpecs(['https://mcp.example.com:8443:ping'])).not.toThrow();
    expect(() => assertValidMcpToolSpecs(['https://mcp.example.com:8443:*'])).not.toThrow();
  });

  it('accepts stdio specs (command[0], no scheme) and omitted/empty lists', () => {
    expect(() => assertValidMcpToolSpecs(['node'])).not.toThrow();
    expect(() => assertValidMcpToolSpecs(['npx*:read_*'])).not.toThrow();
    expect(() => assertValidMcpToolSpecs(undefined)).not.toThrow();
    expect(() => assertValidMcpToolSpecs([])).not.toThrow();
  });
});
