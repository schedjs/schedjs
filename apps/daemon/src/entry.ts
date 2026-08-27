#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { createDaemon } from './daemon.js';
import type { Storage } from '@schedjs/core';

export interface CliOptions {
  tasks: string;
  db: string;
  /**
   * Storage specifier (exactly one, XOR): `sqlite` (default, uses `--db`),
   * a built-in kind (`mongo|mysql|postgres` → `@schedjs/storage-*` + connstring
   * env var), or a custom BYO module (`<npm-package>` | `<./path>` exporting
   * `createStorage(env)`).
   */
  storage: string;
  lockTtlMs: number;
  /** Lock-heartbeat cadence for long sync runs; null → engine default (lockTtl / 3). */
  lockHeartbeatMs: number | null;
  retentionMs: number;
  temporaryRetentionMs: number;
  pollTimeoutMs: number;
  tickIntervalMs: number;
  watchdogIntervalMs: number;
  /** Admin control plane port; null → disabled. */
  adminPort: number | null;
  adminHost: string;
}

const DEFAULTS: CliOptions = {
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
};

function positiveNumber(raw: string, flag: string, scale: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${flag}: expected a positive number, got "${raw}"`);
  return Math.round(n * scale);
}

/**
 * Retention-TTL parser: `0` = retention disabled (prod defect 6 — books wants
 * run history as an archive; the old CLI had no way to turn retention off, and
 * the engine's 30d/24h defaults silently pruned migrated history on the first
 * hourly pass). `>0` = TTL in seconds. Negative / NaN / string → fail fast.
 */
function retentionSeconds(raw: string, flag: string, scale: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${flag}: expected 0 (retention off) or a positive number of seconds, got "${raw}"`);
  return Math.round(n * scale);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** --help text: every flag with its description and default (operators must not grep docs for defaults). */
export function helpText(): string {
  return [
    'schedd daemon — cron done right',
    '',
    'Usage: schedd [--tasks tasks.json] [--db sched.db] [--lock-ttl SECONDS]',
    '        [--lock-heartbeat SECONDS] [--retention-ttl SECONDS] [--temporary-retention-ttl SECONDS]',
    '        [--poll-timeout SECONDS] [--tick-interval MS] [--watchdog-interval MS]',
    '        [--admin-port PORT] [--admin-host HOST] [--storage SPECIFIER]',
    '',
    '  --tasks                     tasks.json path (default: tasks.json)',
    '  --db                        SQLite database path, only with --storage sqlite (default: sched.db)',
    '  --storage                   storage: sqlite (default) | mongo | mysql | postgres |',
    '                               <npm-package> | <./path> (custom module exporting createStorage(env))',
    '                               connstrings come from env: MONGO_URL[/MONGO_DB], MYSQL_URL, PG_URL —',
    '                               never as arguments (they would leak into the process list)',
    '  --lock-ttl                  zombie-lock threshold, seconds (default: 1800 = 30 min)',
    '  --lock-heartbeat            lock refresh cadence for long sync runs, seconds; must be < lock-ttl (default: lock-ttl / 3 = 600 = 10 min)',
    '  --retention-ttl             retention TTL for regular terminal runs, seconds; 0 = retention off (default: 2592000 = 30 d)',
    '  --temporary-retention-ttl   retention TTL for temporary runs, seconds; 0 = retention off (default: 86400 = 24 h)',
    '  --poll-timeout              async (accepted) run ceiling, seconds; must be < lock-ttl (default: 1500 = 25 min)',
    '  --tick-interval             tick cadence, ms (default: 1000)',
    '  --watchdog-interval         watchdog cadence, ms (default: 60000)',
    '  --admin-port PORT           serve the admin api (/api/*) on PORT (SCHED_ADMIN_KEY for auth)',
    '  --admin-host HOST           bind host for the admin server (default: 127.0.0.1)',
    '  (operator CLI ships separately: npx @schedjs/cli — sched status)',
    '  (admin UI ships separately: npx @schedjs/ui — sched-ui serve --proxy http://127.0.0.1:PORT)',
  ].join('\n');
}

/** Parse daemon CLI flags. `--lock-ttl` is in seconds; interval flags in ms. */
export function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      tasks: { type: 'string' },
      db: { type: 'string' },
      'lock-ttl': { type: 'string' },
      'lock-heartbeat': { type: 'string' },
      'retention-ttl': { type: 'string' },
      'temporary-retention-ttl': { type: 'string' },
      'poll-timeout': { type: 'string' },
      'tick-interval': { type: 'string' },
      'watchdog-interval': { type: 'string' },
      'admin-port': { type: 'string' },
      'admin-host': { type: 'string' },
      storage: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true, // unknown flag → hard error (a typo must not silently no-op)
  });

  if (values.help) {
    process.stdout.write(helpText() + '\n');
    process.exit(0);
  }

  const storage = str(values.storage) ?? DEFAULTS.storage;
  // XOR: `--db` is the sqlite knob — a non-sqlite storage with an explicit
  // `--db` is an operator mistake (fail fast; the default db value is inert).
  const explicitDb = str(values.db);
  if (storage !== 'sqlite' && explicitDb !== undefined) {
    throw new Error(`--storage ${storage}: --db is only valid with the sqlite storage (got --db ${explicitDb})`);
  }
  const adminPort = str(values['admin-port']);
  const lockTtlMs = str(values['lock-ttl'])
    ? positiveNumber(str(values['lock-ttl'])!, 'lock-ttl', 1000)
    : DEFAULTS.lockTtlMs;
  const lockHeartbeatMs = str(values['lock-heartbeat'])
    ? positiveNumber(str(values['lock-heartbeat'])!, 'lock-heartbeat', 1000)
    : DEFAULTS.lockHeartbeatMs;
  const pollTimeoutMs = str(values['poll-timeout'])
    ? positiveNumber(str(values['poll-timeout'])!, 'poll-timeout', 1000)
    : DEFAULTS.pollTimeoutMs;
  // r7 F2: the documented invariant is now enforced at parse time — but only
  // for flags the operator actually passed (the poll-timeout default of 25 min
  // is legal against a 30 min ttl; a tiny explicit ttl without an explicit
  // poll-timeout is a sync-only config, not an operator mistake).
  if (str(values['lock-heartbeat']) !== undefined && lockHeartbeatMs !== null && lockHeartbeatMs >= lockTtlMs) {
    throw new Error(`--lock-heartbeat (${lockHeartbeatMs / 1000}s) must be < --lock-ttl (${lockTtlMs / 1000}s)`);
  }
  if (str(values['poll-timeout']) !== undefined && pollTimeoutMs !== null && pollTimeoutMs >= lockTtlMs) {
    throw new Error(`--poll-timeout (${pollTimeoutMs / 1000}s) must be < --lock-ttl (${lockTtlMs / 1000}s)`);
  }
  return {
    tasks: str(values.tasks) ?? DEFAULTS.tasks,
    db: str(values.db) ?? DEFAULTS.db,
    storage,
    lockTtlMs,
    lockHeartbeatMs,
    pollTimeoutMs,
    retentionMs: str(values['retention-ttl'])
      ? retentionSeconds(str(values['retention-ttl'])!, 'retention-ttl', 1000)
      : DEFAULTS.retentionMs,
    temporaryRetentionMs: str(values['temporary-retention-ttl'])
      ? retentionSeconds(str(values['temporary-retention-ttl'])!, 'temporary-retention-ttl', 1000)
      : DEFAULTS.temporaryRetentionMs,
    tickIntervalMs: str(values['tick-interval'])
      ? positiveNumber(str(values['tick-interval'])!, 'tick-interval', 1)
      : DEFAULTS.tickIntervalMs,
    watchdogIntervalMs: str(values['watchdog-interval'])
      ? positiveNumber(str(values['watchdog-interval'])!, 'watchdog-interval', 1)
      : DEFAULTS.watchdogIntervalMs,
    adminPort: adminPort !== undefined ? positiveNumber(adminPort, 'admin-port', 1) : DEFAULTS.adminPort,
    adminHost: str(values['admin-host']) ?? DEFAULTS.adminHost,
  };
}

export interface StorageResolution {
  kind: 'sqlite' | 'mongo' | 'mysql' | 'postgres' | 'custom';
  /** module specifier for dynamic import (custom + built-in kinds). */
  moduleSpec?: string;
  /** env var holding the connstring for built-in kinds (fail-fast before import). */
  connEnvVar?: string;
}

/** Built-in kinds — the daemon knows the table, not the drivers (BYO parity: same createStorage(env) contract). */
const KNOWN_STORAGE_KINDS: Record<string, Pick<StorageResolution, 'moduleSpec' | 'connEnvVar'>> = {
  mongo: { moduleSpec: '@schedjs/storage-mongo', connEnvVar: 'MONGO_URL' },
  mysql: { moduleSpec: '@schedjs/storage-mysql', connEnvVar: 'MYSQL_URL' },
  postgres: { moduleSpec: '@schedjs/storage-postgres', connEnvVar: 'PG_URL' },
};

/**
 * Resolve a `--storage` specifier to its kind. Disjunction: `./`, `../`, `/`
 * → a filesystem path (custom module); anything else that isn't a built-in
 * kind → an npm package (custom module). Both customs must export
 * `createStorage(env): Promise<Storage>`.
 */
export function resolveStorageSpecifier(specifier: string): StorageResolution {
  if (specifier === 'sqlite') return { kind: 'sqlite' };
  const known = KNOWN_STORAGE_KINDS[specifier];
  if (known) return { kind: specifier as StorageResolution['kind'], ...known };
  if (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('/')
  ) {
    return { kind: 'custom', moduleSpec: specifier };
  }
  return { kind: 'custom', moduleSpec: specifier };
}

export interface LoadedStorage {
  storage: Storage;
  /** Sanitized banner: storage=<kind> db=<name> — never the connstring or creds. */
  banner: string;
}
/** DB name from a connstring URL path — driver-agnostic (`mongodb://h:27017/mydb` → `mydb`). */
function dbNameFromUrl(url: string | undefined): string {
  if (!url) return 'default';
  try {
    const path = new URL(url).pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    return path || 'default';
  } catch {
    return 'default';
  }
}

/**
 * Banner db name — the database where the adapter actually lands data, never
 * the connstring or creds. Known defaults: mongo with no db in the URI uses
 * the driver default `test`; mysql/pg have no default (path or `default`).
 */
function bannerDbName(resolution: StorageResolution, env: NodeJS.ProcessEnv): string {
  const url = resolution.connEnvVar ? env[resolution.connEnvVar] : undefined;
  const path = dbNameFromUrl(url);
  if (resolution.kind === 'mongo') {
    if (env.MONGO_DB) return env.MONGO_DB;
    return path === 'default' ? 'test' : path; // mongo driver default db
  }
  return path;
}
/**
 * Load a non-sqlite storage: connstring env fail-fast → dynamic import →
 * `createStorage(env)` BYO contract → sanitized banner. Called before the
 * daemon starts, so a misconfigured storage aborts startup.
 */
export async function loadExternalStorage(resolution: StorageResolution, env: NodeJS.ProcessEnv): Promise<LoadedStorage> {
  if (resolution.kind === 'sqlite') throw new Error('sqlite is built in — nothing to load');

  // fail-fast before any import: a known kind without its connstring env is an
  // operator mistake, not a missing package
  if (resolution.connEnvVar && !env[resolution.connEnvVar]) {
    throw new Error(
      `--storage ${resolution.kind}: ${resolution.connEnvVar} is not set — export ${resolution.connEnvVar}=<connstring> (connstrings live in env/config-volume only, never in arguments)`,
    );
  }

  let mod: unknown;
  try {
    mod = await import(normalizeModuleSpec(resolution.moduleSpec!));
  } catch {
    const hint =
      resolution.kind === 'custom'
        ? `module "${resolution.moduleSpec}" is not installed — add it to your image (RUN yarn add ${resolution.moduleSpec})`
        : `add @schedjs/storage-${resolution.kind} to your image (RUN yarn add @schedjs/storage-${resolution.kind})`;
    throw new Error(`--storage ${resolution.kind}: ${hint}`);
  }

  const createFn = (mod as { createStorage?: (env: NodeJS.ProcessEnv) => Promise<Storage> }).createStorage;
  if (typeof createFn !== 'function') {
    throw new Error(
      `--storage ${resolution.kind}: "${resolution.moduleSpec}" must export createStorage(env): Promise<Storage> — see docs 07.storage (BYO contract)`,
    );
  }
  const storage = await createFn(env);
  if (!storage || typeof storage !== 'object') {
    throw new Error(`--storage ${resolution.kind}: createStorage(env) returned a non-Storage value`);
  }

  // custom modules have no db name (the adapter owns its storage) — the banner
  // shows the module specifier instead, so ops see which adapter actually loaded
  const banner = resolution.kind === 'custom'
    ? `storage=custom module=${resolution.moduleSpec}`
    : `storage=${resolution.kind} db=${bannerDbName(resolution, env)}`;
  return { storage, banner };
}

/**
 * Import specifier for a custom module: path-like specifiers are resolved
 * against the process cwd (operators launch schedd from their config dir), so
 * `--storage ./my-adapter.mjs` means `./my-adapter.mjs` next to tasks.json,
 * not next to the daemon package. npm packages import as-is.
 */
function normalizeModuleSpec(spec: string): string {
  if (spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../') || isAbsolute(spec)) {
    return pathToFileURL(resolve(process.cwd(), spec)).href;
  }
  return spec;
}

async function main(): Promise<void> {
  const opts = parseCliArgs(process.argv.slice(2));
  const resolution = resolveStorageSpecifier(opts.storage);
  const loaded = resolution.kind === 'sqlite' ? null : await loadExternalStorage(resolution, process.env);
  const daemon = createDaemon({
    tasksPath: opts.tasks,
    ...(loaded ? { storage: loaded.storage } : { dbPath: opts.db }),
    lockTtlMs: opts.lockTtlMs,
    ...(opts.lockHeartbeatMs !== null ? { lockHeartbeatMs: opts.lockHeartbeatMs } : {}),
    retentionMs: opts.retentionMs,
    temporaryRetentionMs: opts.temporaryRetentionMs,
    pollTimeoutMs: opts.pollTimeoutMs,
    tickIntervalMs: opts.tickIntervalMs,
    watchdogIntervalMs: opts.watchdogIntervalMs,
    ...(opts.adminPort !== null
      ? {
          admin: {
            port: opts.adminPort,
            host: opts.adminHost,
            ...(process.env.SCHED_ADMIN_KEY ? { apiKey: process.env.SCHED_ADMIN_KEY } : {}),
          },
        }
      : {}),
  });

  const shutdown = () => {
    daemon.stop();
    process.stdout.write('\nschedd: stopped\n');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // win32: Ctrl+Break (Ctrl+C already → SIGINT). SIGTERM via `taskkill` does
  // not always reach a Windows console process — Ctrl+C / Ctrl+Break are the
  // reliable paths there (documented in docs/content/docs/12.cli.md).
  process.on('SIGBREAK', shutdown);

  await daemon.start();
  const adminNote = opts.adminPort !== null
    ? `, admin=http://${opts.adminHost}:${opts.adminPort}${process.env.SCHED_ADMIN_KEY ? ' (auth on)' : ' (NO AUTH!)'}`
    : '';
  const lockHeartbeatMs = opts.lockHeartbeatMs ?? Math.floor(opts.lockTtlMs / 3);
  const storageBanner = loaded ? loaded.banner : `storage=sqlite db=${opts.db}`;
  process.stdout.write(
    `schedd: daemon started (tasks=${opts.tasks}, ${storageBanner}, lockTtl=${opts.lockTtlMs}ms, lockHeartbeat=${lockHeartbeatMs}ms${adminNote})\n`,
  );
}

/**
 * True when this module is the executed entry point. Compares REAL paths:
 * npm global roots under version managers (nvm-windows junction, nvm/volta
 * symlinks on *nix) resolve `import.meta.url` to the real path while
 * `process.argv[1]` keeps the literal prefix — a naive URL comparison would
 * silently skip main() (CLI-F&F critical ping 2026-08-18).
 */
export function isCliMain(argv1: string | undefined, metaUrl: string): boolean {
  if (argv1 === undefined) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

const isMain = isCliMain(process.argv[1], import.meta.url);
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`schedd: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
