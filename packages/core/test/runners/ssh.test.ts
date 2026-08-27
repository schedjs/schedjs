import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSshRunner, fingerprintMatches, hostKeyMismatchError, makeHostKeyVerifier } from '../../src/runners/ssh.js';
import type { SshConnectionConfig, SshTransport } from '../../src/runners/ssh.js';
import type { TaskRecord } from '../../src/types.js';

const task = (config: Record<string, unknown>): TaskRecord => ({
  name: 'ssh-task',
  runner: 'ssh',
  schedule: { kind: 'cron', cron: '0 9 * * *' },
  tz: 'UTC',
  config,
  label: null,
  description: null,
  nextRunAt: new Date('2026-08-16T09:00:00Z'),
  lastRunAt: null,
  lockedAt: null,
  failCount: 0,
  priority: 0,
  retry: null,
  retryCount: 0,
  lastRunId: null,
  paused: false,
  disabled: false,
});

const baseConfig = {
  host: 'vds.example',
  username: 'root',
  command: 'systemctl restart nginx',
  auth: { keyFromEnv: 'SCHED_SSH_KEY_TEST' },
};

/** Recorded view of a transport factory call + a scriptable SshTransport. */
interface MockTransport extends SshTransport {
  cfg: SshConnectionConfig;
  auth: { privateKey?: string; password?: string };
  fingerprints: string[] | undefined;
  execCalls: string[];
  killed: boolean;
  closed: boolean;
}

function mockFactory(
  script: (t: MockTransport, hooks: { onStdout(c: string): void; onStderr(c: string): void }) =>
    | Promise<{ code: number | null; signal: string | null }>
    | { code: number | null; signal: string | null }
    | void,
): (cfg: SshConnectionConfig, auth: { privateKey?: string; password?: string }, fingerprints?: string[]) => SshTransport {
  return (cfg, auth, fingerprints) => {
    const t: MockTransport = {
      cfg,
      auth,
      fingerprints,
      execCalls: [],
      killed: false,
      closed: false,
      exec(command, hooks) {
        this.execCalls.push(command);
        const r = script(this, hooks);
        return Promise.resolve(r ?? { code: null, signal: null });
      },
      kill() {
        this.killed = true;
      },
      close() {
        this.closed = true;
      },
    };
    return t;
  };
}

const env: Record<string, string> = { SCHED_SSH_KEY_TEST: '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----' };
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of Object.keys(env)) {
    savedEnv[k] = process.env[k];
    process.env[k] = env[k];
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('ssh runner — dispatch and outcome mapping', () => {
  it('connects with resolved key auth and runs the remote command (exit 0 → succeeded)', async () => {
    let seen: MockTransport | undefined;
    const runner = createSshRunner({
      transport: mockFactory((t) => {
        seen = t;
        return Promise.resolve({ code: 0, signal: null });
      }),
    });

    const outcome = await runner.run(task(baseConfig), 'run-1', new Date());

    expect(outcome).toEqual({ status: 'succeeded', log: '' });
    expect(seen!.cfg).toEqual({ host: 'vds.example', port: 22, username: 'root' });
    expect(seen!.auth.privateKey).toBe(env.SCHED_SSH_KEY_TEST);
    expect(seen!.execCalls).toEqual(['systemctl restart nginx']);
    expect(seen!.closed).toBe(true); // connection disposed after the run
  });

  it('captures stdout+stderr into the run log', async () => {
    const runner = createSshRunner({
      transport: mockFactory((_t, hooks) => {
        hooks.onStdout('out-line\n');
        hooks.onStderr('err-line\n');
        return Promise.resolve({ code: 0, signal: null });
      }),
    });
    const outcome = await runner.run(task(baseConfig), 'run-1', new Date());
    expect(outcome).toEqual({ status: 'succeeded', log: 'out-line\nerr-line\n' });
  });

  it('maps non-zero exit to failed with exit code and log tail', async () => {
    const runner = createSshRunner({
      transport: mockFactory(() => Promise.resolve({ code: 3, signal: null })),
    });
    const outcome = await runner.run(task(baseConfig), 'run-1', new Date());
    expect(outcome).toEqual({ status: 'failed', error: 'exit 3: ', log: '' });
  });

  it('fails when the transport cannot connect (host unreachable / bad auth / fingerprint mismatch)', async () => {
    const runner = createSshRunner({
      transport: mockFactory(() => Promise.reject(new Error('fingerprint mismatch: host key not in allowlist'))),
    });
    const outcome = await runner.run(task(baseConfig), 'run-1', new Date());
    expect(outcome.status).toBe('failed');
    expect((outcome as { error: string }).error).toContain('fingerprint mismatch');
  });

  it('kills the connection on timeout and reports cancelled', async () => {
    let seen: MockTransport | undefined;
    const runner = createSshRunner({
      transport: mockFactory((t) => {
        seen = t;
        return new Promise(() => {
          /* never settles — the runner must kill */
        });
      }),
      timeoutMs: 50,
    });
    const outcome = await runner.run(task(baseConfig), 'run-1', new Date());
    expect(seen!.killed).toBe(true);
    expect(outcome).toEqual({ status: 'cancelled', error: 'timeout after 50ms', log: '' });
  });

  it('fails fast on missing host / username / command / auth', async () => {
    const runner = createSshRunner({ transport: mockFactory(() => Promise.resolve({ code: 0, signal: null })) });
    const missing = (config: Record<string, unknown>) => runner.run(task(config), 'run-1', new Date());

    expect((await missing({})).status).toBe('failed');
    expect((await missing({ host: 'h' })).status).toBe('failed');
    expect((await missing({ host: 'h', username: 'u' })).status).toBe('failed');
    expect((await missing({ host: 'h', username: 'u', command: 'c' })).status).toBe('failed');
    expect((await missing({ host: 'h', username: 'u', command: 'c', auth: {} })).status).toBe('failed');
    expect((await missing({ host: 'h', username: 'u', command: 'c', auth: { keyFromEnv: 'MISSING_ENV' } })).status).toBe('failed');
  });
});

describe('ssh runner — validateConfig (load-time fail-fast)', () => {
  it('rejects bad config before any run', () => {
    const runner = createSshRunner({ transport: mockFactory(() => Promise.resolve({ code: 0, signal: null })) });
    expect(() => runner.validateConfig?.({ name: 't', config: {} })).toThrow(/host/);
    expect(() => runner.validateConfig?.({ name: 't', config: { host: 'h' } })).toThrow(/username/);
    expect(() => runner.validateConfig?.({ name: 't', config: { host: 'h', username: 'u' } })).toThrow(/command/);
    expect(() =>
      runner.validateConfig?.({ name: 't', config: { host: 'h', username: 'u', command: 'c' } }),
    ).toThrow(/auth/);
    expect(() =>
      runner.validateConfig?.({
        name: 't',
        config: { host: 'h', username: 'u', command: 'c', auth: { keyFromEnv: 'X', passwordFromEnv: 'Y' } },
      }),
    ).toThrow(/one of/i);
    expect(() =>
      runner.validateConfig?.({ name: 't', config: { host: 'h', username: 'u', command: 'c', auth: { keyFromEnv: 'NOPE' } } }),
    ).toThrow(/NOPE/); // env var must exist at load
    expect(() => runner.validateConfig?.({ name: 't', config: baseConfig })).not.toThrow();
  });

  it('rejects malformed fingerprints at load time', () => {
    const runner = createSshRunner({ transport: mockFactory(() => Promise.resolve({ code: 0, signal: null })) });
    expect(() =>
      runner.validateConfig?.({ name: 't', config: { ...baseConfig, fingerprints: ['not-a-fingerprint'] } }),
    ).toThrow(/fingerprint/i);
    expect(() =>
      runner.validateConfig?.({ name: 't', config: { ...baseConfig, fingerprints: ['SHA256:abc123'] } }),
    ).not.toThrow();
  });

  it('rejects ceiling-subset and malformed allowedTools at load time (policy before mechanics)', () => {
    const runner = createSshRunner({ allowedTools: ['systemctl*'] });
    // task declares a tool outside the ceiling → fails even with a valid shape
    expect(() =>
      runner.validateConfig?.({ name: 't', config: { ...baseConfig, allowedTools: ['rm*'] } }),
    ).toThrow(/not a subset/);
    expect(() => runner.validateConfig?.({ name: 't', config: { ...baseConfig, allowedTools: 'rm' } })).toThrow(
      /array of non-empty strings/,
    );
    expect(() => runner.validateConfig?.({ name: 't', config: { ...baseConfig, allowedTools: ['systemctl*'] } })).not.toThrow();
  });

  it('rejects a command outside the ceiling at load time (no per-task allowedTools)', () => {
    const runner = createSshRunner({ allowedTools: ['systemctl*'] });
    // no per-task allowedTools — the ceiling still gates the command's first token at load
    expect(() =>
      runner.validateConfig?.({ name: 't', config: { ...baseConfig, command: 'rm -rf /' } }),
    ).toThrow(/not in runner allowedTools/);
    expect(() => runner.validateConfig?.({ name: 't', config: baseConfig })).not.toThrow();
  });
});

describe('ssh runner — allowedTools sandbox (per-task + ceiling)', () => {
  it('blocks a non-allowlisted command without opening a connection', async () => {
    let connected = false;
    const base = mockFactory(() => Promise.resolve({ code: 0, signal: null }));
    const runner = createSshRunner({
      allowedTools: ['systemctl*'],
      transport: (cfg, auth, fps) => {
        connected = true;
        return base(cfg, auth, fps);
      },
    });

    const blocked = await runner.run(
      task({ ...baseConfig, command: 'rm -rf /' }),
      'run-1',
      new Date(),
    );
    expect(connected).toBe(false);
    expect(blocked.status).toBe('failed');
    expect(blocked.status === 'failed' ? blocked.error : '').toContain('allowedTools');

    const allowed = await runner.run(task({ ...baseConfig }), 'run-2', new Date());
    expect(connected).toBe(true);
    expect(allowed.status).toBe('succeeded');
  });

  it('enforces the per-task allowedTools (first token of the command is the tool)', async () => {
    const runner = createSshRunner({ transport: mockFactory(() => Promise.resolve({ code: 0, signal: null })) });
    const blocked = await runner.run(
      task({ ...baseConfig, command: 'sh -c "rm -rf /"', allowedTools: ['systemctl*'] }),
      'run-1',
      new Date(),
    );
    expect(blocked.status).toBe('failed');
    expect(blocked.status === 'failed' ? blocked.error : '').toContain('sh');

    const allowed = await runner.run(
      task({ ...baseConfig, command: 'systemctl restart nginx', allowedTools: ['systemctl*'] }),
      'run-2',
      new Date(),
    );
    expect(allowed.status).toBe('succeeded');
  });
});

describe('ssh runner — fingerprint matching (pure)', () => {
  const hex = '00'.repeat(32); // 32-byte SHA256 hash as hex
  const b64 = Buffer.from(hex, 'hex').toString('base64');

  it('matches hex, base64 and SHA256:base64 pin forms', () => {
    expect(fingerprintMatches(hex, [hex])).toBe(true);
    expect(fingerprintMatches(hex, [b64])).toBe(true);
    expect(fingerprintMatches(hex, [`SHA256:${b64}`])).toBe(true);
    expect(fingerprintMatches(hex, [`SHA256:${'A'.repeat(44)}`])).toBe(false);
  });

  it('no pins = accept (trust-unpinned, documented)', () => {
    expect(fingerprintMatches(hex, undefined)).toBe(true);
    expect(fingerprintMatches(hex, [])).toBe(true);
  });

  it('names expected pins and the received fingerprint on mismatch (r6 F3)', () => {
    const pins = ['SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='];
    const err = hostKeyMismatchError(pins, 'deadbeef');
    expect(err.message).toContain('received deadbeef');
    expect(err.message).toContain(pins[0]!);
    expect(err.message).toMatch(/expected one of \[/);
  });

  it('host-key verifier reports the received fingerprint on rejection (r6 F3)', () => {
    const rejected: string[] = [];
    const pins = ['SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='];
    const verify = makeHostKeyVerifier(pins, (fp) => rejected.push(fp));
    expect(verify('deadbeef')).toBe(false);
    expect(rejected).toEqual(['deadbeef']);
    const hash = Buffer.from(pins[0]!.replace(/^SHA256:/i, ''), 'base64').toString('hex');
    expect(verify(hash)).toBe(true);
    expect(rejected).toEqual(['deadbeef']); // only the rejected one reported
  });
});

  it('handles a raw Buffer host key from ssh2 (f&f r3: keyHash.replace crash)', () => {
    // ssh2 calls hostVerifier with a Buffer when cfg.hostHash is unset; the
    // PIN path must not crash on .replace — it should hex-digest the buffer.
    const raw = Buffer.from('placeholder host key bytes');
    expect(() => fingerprintMatches(raw as unknown as string, ['SHA256:whatever'])).not.toThrow();
  });
