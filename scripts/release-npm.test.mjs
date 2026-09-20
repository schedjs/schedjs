import { describe, expect, it } from 'vitest';
import {
  PUBLISH_ORDER,
  assertPackedManifest,
  checkInstalled,
  parseNpmVersions,
  planWave,
  readTarEntry,
} from './release-npm-lib.mjs';

const WS = [
  { name: '@schedjs/core', version: '0.55.0', dir: 'packages/core' },
  { name: '@schedjs/daemon', version: '0.13.2', dir: 'apps/daemon' },
  { name: '@schedjs/admin-api', version: '0.3.3', dir: 'packages/admin-api' },
  { name: '@schedjs/cli', version: '0.2.0', dir: 'packages/cli' },
  { name: '@schedjs/mcp', version: '0.5.2', dir: 'packages/mcp' },
  { name: '@schedjs/storage-mongo', version: '0.5.1', dir: 'packages/storage-mongo' },
];

// Полный workspace (девять пакетов scope) — для проверки «ничего не пропущено».
const FULL_WS = [
  ...WS,
  { name: '@schedjs/storage-mysql', version: '0.4.2', dir: 'packages/storage-mysql' },
  { name: '@schedjs/storage-postgres', version: '0.4.2', dir: 'packages/storage-postgres' },
  { name: '@schedjs/ui', version: '0.3.1', dir: 'packages/ui' },
];

describe('planWave', () => {
  it('публикует всё, чего нет в реестре, в канонном депс-фёрст порядке', () => {
    const plan = planWave(FULL_WS, {});
    expect(plan.publish.map((p) => p.name)).toEqual([...PUBLISH_ORDER]);
    expect(plan.skip).toEqual([]);
  });

  it('идемпотентен: уже опубликованная версия уходит в skip, а не в publish', () => {
    const plan = planWave(WS, {
      '@schedjs/core': ['0.54.0', '0.55.0'],
      '@schedjs/mcp': ['0.5.2'],
    });
    const names = plan.publish.map((p) => p.name);
    expect(names).not.toContain('@schedjs/core');
    expect(names).not.toContain('@schedjs/mcp');
    expect(plan.skip).toEqual(
      expect.arrayContaining([
        { name: '@schedjs/core', version: '0.55.0', reason: 'версия уже в реестре' },
        { name: '@schedjs/mcp', version: '0.5.2', reason: 'версия уже в реестре' },
      ]),
    );
  });

  it('повторный прогон после частичного падения продолжает с середины волны', () => {
    // падение на mcp: core/storage-mongo/admin-api успели уехать
    const plan = planWave(WS, {
      '@schedjs/core': ['0.55.0'],
      '@schedjs/storage-mongo': ['0.5.1'],
      '@schedjs/admin-api': ['0.3.3'],
    });
    expect(plan.publish.map((p) => p.name)).toEqual(['@schedjs/mcp', '@schedjs/daemon', '@schedjs/cli']);
  });

  it('пакет scope вне канонного порядка не теряется молча — публикуется после канонных', () => {
    const plan = planWave([...WS, { name: '@schedjs/storage-sqlite', version: '0.1.0', dir: 'packages/storage-sqlite' }], {});
    expect(plan.publish.map((p) => p.name)).toEqual([
      '@schedjs/core',
      '@schedjs/storage-mongo',
      '@schedjs/admin-api',
      '@schedjs/mcp',
      '@schedjs/daemon',
      '@schedjs/cli',
      '@schedjs/storage-sqlite',
    ]);
    expect(plan.order.at(-1)).toBe('@schedjs/storage-sqlite');
  });

  it('отсутствующий в workspace пакет канонного порядка виден в skip, а не падает', () => {
    const plan = planWave([{ name: '@schedjs/core', version: '0.55.0', dir: 'packages/core' }], {});
    expect(plan.skip).toEqual(
      expect.arrayContaining([{ name: '@schedjs/ui', version: '', reason: 'нет в workspace' }]),
    );
  });

  it('не-schedjs пакеты (private-воркспейсы, docs) в план не попадают', () => {
    const plan = planWave([...WS, { name: 'sched', version: '0.1.0', dir: '.' }, { name: 'docs', version: '0.0.0', dir: 'docs' }], {});
    expect(plan.publish.every((p) => p.name.startsWith('@schedjs/'))).toBe(true);
  });

  it('PUBLISH_ORDER — все девять пакетов scope, порядок стабилен', () => {
    expect(PUBLISH_ORDER).toHaveLength(9);
    expect(PUBLISH_ORDER[0]).toBe('@schedjs/core');
    expect(PUBLISH_ORDER.at(-1)).toBe('@schedjs/cli');
  });
});

describe('assertPackedManifest (пак-чек gotcha 18/19)', () => {
  it('чистый манифест с точными пинами проходит', () => {
    expect(assertPackedManifest({ dependencies: { '@schedjs/core': '0.55.0' } })).toEqual({ ok: true, violations: [] });
  });

  it('workspace: в dependencies/peerDependencies/optionalDependencies — нарушение с адресом', () => {
    const r = assertPackedManifest({
      dependencies: { '@schedjs/core': 'workspace:*' },
      peerDependencies: { '@schedjs/mcp': 'workspace:^' },
      optionalDependencies: { '@schedjs/ui': 'workspace:~' },
    });
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual([
      'dependencies.@schedjs/core=workspace:*',
      'peerDependencies.@schedjs/mcp=workspace:^',
      'optionalDependencies.@schedjs/ui=workspace:~',
    ]);
  });

  it('devDependencies не проверяются (в тарбол не едут) и пустой манифест не падает', () => {
    expect(assertPackedManifest({ devDependencies: { '@schedjs/core': 'workspace:*' } })).toEqual({ ok: true, violations: [] });
    expect(assertPackedManifest(undefined)).toEqual({ ok: true, violations: [] });
  });
});

describe('parseNpmVersions', () => {
  it('JSON-массив версий', () => {
    expect(parseNpmVersions('["0.54.0","0.55.0"]')).toEqual(['0.54.0', '0.55.0']);
  });
  it('единственная версия строкой', () => {
    expect(parseNpmVersions('"0.55.0"')).toEqual(['0.55.0']);
  });
  it('ошибка npm / пустой вывод → пусто (пакет не публиковался)', () => {
    expect(parseNpmVersions('npm error code E404')).toEqual([]);
    expect(parseNpmVersions('')).toEqual([]);
    expect(parseNpmVersions(undefined)).toEqual([]);
  });
  it('plain-вывод построчно (npm view без --json)', () => {
    expect(parseNpmVersions('0.54.0\n0.55.0')).toEqual(['0.54.0', '0.55.0']);
  });
});

describe('checkInstalled (инсталл-смоук)', () => {
  it('дерево без workspace: и с резолвнутыми пинами — зелёное', () => {
    const r = checkInstalled([
      { name: '@schedjs/daemon', manifest: { dependencies: { '@schedjs/core': '0.55.0' } } },
      { name: '@schedjs/core', manifest: {} },
    ]);
    expect(r).toEqual({ ok: true, problems: [] });
  });

  it('ловит workspace: и нерезолвленный file:-пин с адресом пакета', () => {
    const r = checkInstalled([
      { name: '@schedjs/admin-api', manifest: { dependencies: { '@schedjs/core': 'workspace:*' } } },
      { name: '@schedjs/mcp', manifest: { dependencies: { '@schedjs/core': 'file:../core' } } },
    ]);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      '@schedjs/admin-api: dependencies.@schedjs/core=workspace:*',
      '@schedjs/mcp: нерезолвленная зависимость @schedjs/core=file:../core',
    ]);
  });

  it('отсутствующий манифест в node_modules — проблема, а не тихий проход', () => {
    const r = checkInstalled([{ name: '@schedjs/ui', manifest: null }]);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(['@schedjs/ui: манифест не найден в node_modules']);
  });
});

// --- readTarEntry: tar-парсер (Windows: GNU tar в PATH ломается на `C:\...`) ---
import { gzipSync } from 'node:zlib';

/** Собрать минимальный .tgz в памяти: [name, content][] + два нулевых блока. */
function makeTgz(entries) {
  const blocks = [];
  for (const [name, content] of entries) {
    const data = Buffer.from(content, 'utf8');
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644', 100, 8, 'utf8'); // mode
    header.write('0000000', 108, 8, 'utf8'); // uid
    header.write('0000000', 116, 8, 'utf8'); // gid
    header.write(data.length.toString(8).padStart(11, '0'), 124, 12, 'utf8');
    header.write('00000000000', 136, 12, 'utf8'); // mtime
    header.write('0', 156, 1, 'utf8'); // typeflag = обычный файл
    header.write('ustar', 257, 6, 'utf8');
    blocks.push(header, data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length));
  }
  blocks.push(Buffer.alloc(1024)); // конец архива
  return gzipSync(Buffer.concat(blocks));
}

describe('readTarEntry', () => {
  const tgz = makeTgz([
    ['package/package.json', JSON.stringify({ name: '@schedjs/core', version: '0.55.0' })],
    ['package/dist/index.js', 'export const x = 1;'],
  ]);

  it('достаёт package/package.json из .tgz (и не путает с другими записями)', () => {
    const manifest = JSON.parse(readTarEntry(tgz, 'package/package.json'));
    expect(manifest).toEqual({ name: '@schedjs/core', version: '0.55.0' });
  });

  it('находит запись с префиксом ./ (некоторые упаковщики пишут так)', () => {
    const tgz2 = makeTgz([['./package/package.json', '{"version":"1.0.0"}']]);
    expect(JSON.parse(readTarEntry(tgz2, 'package/package.json')).version).toBe('1.0.0');
  });

  it('возвращает undefined для отсутствующей записи (а не мусор)', () => {
    expect(readTarEntry(tgz, 'package/nope.json')).toBeUndefined();
  });

  it('читает вторую запись архива (сдвиг по блокам считается верно)', () => {
    expect(readTarEntry(tgz, 'package/dist/index.js')).toBe('export const x = 1;');
  });
});
