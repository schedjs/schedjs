import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isCliMain, parseCliArgs, helpText } from '../src/entry.js';

describe('parseCliArgs', () => {
  it('applies defaults', () => {
    const opts = parseCliArgs([]);
    expect(opts).toEqual({
      tasks: 'tasks.json',
      db: 'sched.db',
      storage: 'sqlite',
      lockTtlMs: 30 * 60 * 1000,
      lockHeartbeatMs: null,
      retentionMs: 30 * 24 * 60 * 60 * 1000,
      temporaryRetentionMs: 24 * 60 * 60 * 1000,
      pollTimeoutMs: 25 * 60 * 1000,
      tickIntervalMs: 1_000,
      watchdogIntervalMs: 60_000,
      adminPort: null,
      adminHost: '127.0.0.1',
    });
  });

  it('parses explicit flags', () => {
    const opts = parseCliArgs([
      '--tasks',
      'config/tasks.json',
      '--db',
      '/tmp/sched.db',
      '--lock-ttl',
      '600',
      '--lock-heartbeat',
      '120',
      '--retention-ttl',
      '120',
      '--temporary-retention-ttl',
      '60',
      '--poll-timeout',
      '300',
      '--tick-interval',
      '500',
      '--watchdog-interval',
      '30000',
      '--admin-port',
      '8080',
      '--admin-host',
      '0.0.0.0',
    ]);
    expect(opts.tasks).toBe('config/tasks.json');
    expect(opts.db).toBe('/tmp/sched.db');
    expect(opts.lockTtlMs).toBe(600_000);
    expect(opts.lockHeartbeatMs).toBe(120_000);
    expect(opts.retentionMs).toBe(120_000);
    expect(opts.temporaryRetentionMs).toBe(60_000);
    expect(opts.pollTimeoutMs).toBe(300_000);
    expect(opts.tickIntervalMs).toBe(500);
    expect(opts.watchdogIntervalMs).toBe(30_000);
    expect(opts.adminPort).toBe(8080);
    expect(opts.adminHost).toBe('0.0.0.0');
  });

  it('rejects --lock-heartbeat >= --lock-ttl and --poll-timeout >= --lock-ttl (r7 F2)', () => {
    expect(() => parseCliArgs(['--lock-ttl', '20', '--lock-heartbeat', '20'])).toThrow(/lock-heartbeat/);
    expect(() => parseCliArgs(['--lock-ttl', '20', '--lock-heartbeat', '30'])).toThrow(/lock-heartbeat/);
    expect(() => parseCliArgs(['--lock-ttl', '20', '--poll-timeout', '20'])).toThrow(/poll-timeout/);
    // valid combos
    expect(() => parseCliArgs(['--lock-ttl', '20', '--lock-heartbeat', '10'])).not.toThrow();
  });

  it('throws on a non-numeric interval', () => {
    expect(() => parseCliArgs(['--lock-ttl', 'abc'])).toThrow();
  });

  it('accepts --retention-ttl 0 / --temporary-retention-ttl 0 = retention off (prod defect 6: archive semantics)', () => {
    const opts = parseCliArgs(['--retention-ttl', '0', '--temporary-retention-ttl', '0']);
    expect(opts.retentionMs).toBe(0);
    expect(opts.temporaryRetentionMs).toBe(0);
    // a positive value still parses
    expect(parseCliArgs(['--retention-ttl', '5']).retentionMs).toBe(5_000);
    // garbage / negative still fail fast
    expect(() => parseCliArgs(['--retention-ttl', '-1'])).toThrow(/retention-ttl/);
    expect(() => parseCliArgs(['--temporary-retention-ttl', 'abc'])).toThrow(/temporary-retention-ttl/);
  });

  it('help text lists every flag with its default (operators must not grep docs for defaults)', () => {
    const help = helpText();
    expect(help).toContain('--lock-ttl');
    expect(help).toContain('--lock-heartbeat');
    expect(help).toContain('--retention-ttl');
    expect(help).toContain('--temporary-retention-ttl');
    expect(help).toContain('--poll-timeout');
    expect(help).toContain('--tick-interval');
    expect(help).toContain('--watchdog-interval');
    expect(help).toContain('--admin-port');
    expect(help).toContain('--admin-host');
    expect(help).toContain('2592000'); // retention-ttl default (30d, seconds)
    expect(help).toContain('86400'); // temporary-retention-ttl default (24h, seconds)
    expect(help).toContain('1800'); // lock-ttl default
    expect(help).toContain('600'); // lock-heartbeat default (lock-ttl / 3, seconds)
    expect(help).toContain('1500'); // poll-timeout default
  });

  it('throws on an unknown flag — fail fast on a typo instead of silent ignore', () => {
    expect(() => parseCliArgs(['--nope-flag'])).toThrow();
  });
});

describe('isCliMain (nvm junction-safe entry detection — CLI-F&F critical ping)', () => {
  /** temp dir + a junction/symlink to it; returns the same file via both spellings. */
  function junctionPair(): { realPath: string; linkPath: string } | null {
    const base = mkdtempSync(join(tmpdir(), 'schedd-main-'));
    const realDir = join(base, 'real');
    mkdirSync(realDir);
    const realPath = join(realDir, 'cli.js');
    writeFileSync(realPath, '// main');
    const linkDir = join(base, 'link');
    try {
      symlinkSync(realDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return null; // no junction permission — env without the failure mode
    }
    const linkPath = join(linkDir, 'cli.js');
    return linkPath === realPath ? null : { realPath, linkPath };
  }

  it('detects main via the real path', () => {
    const pair = junctionPair();
    if (!pair) return;
    expect(isCliMain(pair.realPath, pathToFileURL(pair.realPath).href)).toBe(true);
  });

  it('detects main through a junction prefix (nvm global root regression)', () => {
    const pair = junctionPair();
    if (!pair) return;
    // the bug: argv[1] carries the junction prefix, import.meta.url the real
    // path — a naive URL comparison returns false and main() never runs.
    expect(pathToFileURL(pair.linkPath).href).not.toBe(pathToFileURL(pair.realPath).href);
    expect(isCliMain(pair.linkPath, pathToFileURL(pair.realPath).href)).toBe(true);
  });

  it('rejects a different entry file', () => {
    const pair = junctionPair();
    if (!pair) return;
    expect(isCliMain('/some/other/entry.js', pathToFileURL(pair.realPath).href)).toBe(false);
  });

  it('rejects missing argv[1]', () => {
    expect(isCliMain(undefined, 'file:///x/cli.js')).toBe(false);
  });
});
