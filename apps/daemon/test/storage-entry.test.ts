import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCliArgs, resolveStorageSpecifier, loadExternalStorage } from '../src/entry.js';

describe('storage specifier resolution (--storage disjunction)', () => {
  it('sqlite → the built-in kind (no module, no env)', () => {
    expect(resolveStorageSpecifier('sqlite')).toEqual({ kind: 'sqlite' });
  });

  it('known kinds map to @schedjs/storage-* + their connstring env var', () => {
    expect(resolveStorageSpecifier('mongo')).toEqual({
      kind: 'mongo',
      moduleSpec: '@schedjs/storage-mongo',
      connEnvVar: 'MONGO_URL',
    });
    expect(resolveStorageSpecifier('mysql')).toEqual({
      kind: 'mysql',
      moduleSpec: '@schedjs/storage-mysql',
      connEnvVar: 'MYSQL_URL',
    });
    expect(resolveStorageSpecifier('postgres')).toEqual({
      kind: 'postgres',
      moduleSpec: '@schedjs/storage-postgres',
      connEnvVar: 'PG_URL',
    });
  });

  it('path-like specifiers (./ ../ /) resolve to a custom filesystem module', () => {
    expect(resolveStorageSpecifier('./my-adapter.mjs')).toEqual({ kind: 'custom', moduleSpec: './my-adapter.mjs' });
    expect(resolveStorageSpecifier('../adapters/x.mjs')).toEqual({ kind: 'custom', moduleSpec: '../adapters/x.mjs' });
    expect(resolveStorageSpecifier('/opt/sched/my-adapter.mjs')).toEqual({ kind: 'custom', moduleSpec: '/opt/sched/my-adapter.mjs' });
  });

  it('anything else is a custom npm package (BYO)', () => {
    expect(resolveStorageSpecifier('@org/sched-storage-xyz')).toEqual({ kind: 'custom', moduleSpec: '@org/sched-storage-xyz' });
    expect(resolveStorageSpecifier('sched-storage-redis')).toEqual({ kind: 'custom', moduleSpec: 'sched-storage-redis' });
  });
});

describe('parseCliArgs --storage XOR', () => {
  it('--db is sqlite-only: --storage <kind> --db x.db fails fast', () => {
    expect(() => parseCliArgs(['--storage', 'mongo', '--db', 'x.db'])).toThrow(/--db/);
    expect(() => parseCliArgs(['--storage', 'mysql', '--db', 'x.db'])).toThrow(/--db/);
    expect(() => parseCliArgs(['--storage', './a.mjs', '--db', 'x.db'])).toThrow(/--db/);
  });

  it('--storage without --db parses (default db is not an error)', () => {
    expect(parseCliArgs(['--storage', 'mongo']).storage).toBe('mongo');
    expect(parseCliArgs(['--storage', 'mysql']).storage).toBe('mysql');
    expect(parseCliArgs(['--storage', '@org/sched-storage-xyz']).storage).toBe('@org/sched-storage-xyz');
  });

  it('--storage sqlite keeps --db (the default and the flag both work)', () => {
    expect(parseCliArgs([]).storage).toBe('sqlite');
    expect(parseCliArgs(['--db', '/data/sched.db']).db).toBe('/data/sched.db');
    expect(parseCliArgs(['--storage', 'sqlite', '--db', '/data/sched.db']).storage).toBe('sqlite');
  });
});

describe('loadExternalStorage — env fail-fast, dynamic import, BYO contract', () => {
  it('known kind without its connstring env → error naming the env var, BEFORE any import', async () => {
    await expect(loadExternalStorage(resolveStorageSpecifier('mongo'), {})).rejects.toThrow(/MONGO_URL/);
    await expect(loadExternalStorage(resolveStorageSpecifier('mysql'), {})).rejects.toThrow(/MYSQL_URL/);
    await expect(loadExternalStorage(resolveStorageSpecifier('postgres'), {})).rejects.toThrow(/PG_URL/);
  });

  it('known kind with the env set but module missing → "add @schedjs/storage-<kind> to your image (RUN yarn add …)"', async () => {
    // @schedjs/storage-<kind> IS resolvable inside the monorepo workspace, so the
    // missing-package path is exercised through a custom specifier that does
    // not exist — same import failure the daemon hits in a bare image.
    await expect(
      loadExternalStorage({ kind: 'mongo', moduleSpec: '@schedjs/storage-definitely-missing', connEnvVar: 'MONGO_URL' }, { MONGO_URL: 'mongodb://x' }),
    ).rejects.toThrow(/add @schedjs\/storage-mongo to your image/);
  });

  it('custom module that does not export createStorage → BYO contract error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-storage-'));
    const mod = join(dir, 'bad.mjs');
    writeFileSync(mod, 'export const notCreateStorage = 42;\n');
    await expect(loadExternalStorage({ kind: 'custom', moduleSpec: mod }, {})).rejects.toThrow(/createStorage\(env\)/);
  });

  it('custom module whose createStorage is not a function → same BYO contract error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-storage-'));
    const mod = join(dir, 'bad2.mjs');
    writeFileSync(mod, 'export const createStorage = "nope";\n');
    await expect(loadExternalStorage({ kind: 'custom', moduleSpec: mod }, {})).rejects.toThrow(/createStorage\(env\)/);
  });

  it('custom path module exporting createStorage(env) → loads storage + sanitized banner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-storage-'));
    const mod = join(dir, 'ok.mjs');
    writeFileSync(
      mod,
      `export async function createStorage(env) {
        return { kind: 'custom-storage', marker: env.MY_MARKER, async listTasks() { return []; } };
      }\n`,
    );
    const { storage, banner } = await loadExternalStorage(
      { kind: 'custom', moduleSpec: mod },
      { MY_MARKER: 'hello' },
    );
    expect(storage).toMatchObject({ kind: 'custom-storage', marker: 'hello' });
    expect(banner).toContain('storage=custom');
    // N2 (F&F 2026-08-21): custom modules have no db name — the banner shows the
    // module specifier instead of a meaningless `db=default`
    expect(banner).toContain('module=');
    expect(banner).toContain(mod);
  });

  it('banner never carries the connstring or credentials — only kind + db name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-storage-'));
    const mod = join(dir, 'ok2.mjs');
    writeFileSync(mod, 'export async function createStorage() { return { async listTasks() { return []; } }; }\n');
    const secretUrl = 'mongodb://user:secretpass@db.internal:27017/prod-db?replicaSet=rs0';
    const { banner } = await loadExternalStorage(
      { kind: 'mongo', moduleSpec: mod, connEnvVar: 'MONGO_URL' },
      { MONGO_URL: secretUrl },
    );
    expect(banner).toContain('storage=mongo');
    expect(banner).toContain('db=prod-db');
    expect(banner).not.toContain('secretpass');
    expect(banner).not.toContain('db.internal');
    expect(banner).not.toContain('mongodb://');
  });
  it('mongo db-name override MONGO_DB wins over the URI path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-storage-'));
    const mod = join(dir, 'ok3.mjs');
    writeFileSync(mod, 'export async function createStorage() { return { async listTasks() { return []; } }; }\n');
    const { banner } = await loadExternalStorage(
      { kind: 'mongo', moduleSpec: mod, connEnvVar: 'MONGO_URL' },
      { MONGO_URL: 'mongodb://user:pass@db.internal:27017/uri-db', MONGO_DB: 'override-db' },
    );
    expect(banner).toContain('db=override-db');
  });
});
