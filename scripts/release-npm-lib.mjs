// release-npm-lib.mjs — чистая логика OIDC-релиза @schedjs/* (task:3130).
// Отделена от I/O (yarn pack / npm view / npm publish), чтобы тестироваться
// юнитами без сети. Сам CLI — release-npm.mjs.
//
// Зачем: с августа 2026 granular-токен с bypass-2FA публикует только в staging
// (approve человеком с 2FA). Волна R1 (task:3089) встала ровно на этом шаге.
// Переход на trusted publishing (OIDC) снимает approve: публикует CI, токена в
// env нет. Порядок волны и гейт пак-чека — из ранбука (wiki:3332).
import { gunzipSync } from 'node:zlib';

/**
 * Достать файл из .tgz чистыми средствами Node (tar-парсер на 40 строк).
 * Зачем не `tar`: на Windows в PATH первым может оказаться GNU tar из Git Bash,
 * который трактует `C:\...` как удалённый хост (`Cannot connect to C:`) — а
 * релиз-скрипт обязан вести себя одинаково локально и на Linux-runner'е.
 *
 * @param {Buffer} gzBuffer содержимое .tgz
 * @param {string} entryName путь внутри архива (напр. `package/package.json`)
 * @returns {string|undefined} содержимое или undefined, если записи нет
 */
export function readTarEntry(gzBuffer, entryName) {
  const buf = gunzipSync(gzBuffer);
  const wanted = new Set([entryName, './' + entryName]);
  const NUL = String.fromCharCode(0);
  const stripAtNul = (s) => {
    const i = s.indexOf(NUL);
    return i < 0 ? s : s.slice(0, i);
  };
  let off = 0;

  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // два нулевых блока = конец архива

    const name = stripAtNul(header.subarray(0, 100).toString('utf8'));
    const sizeField = stripAtNul(header.subarray(124, 136).toString('utf8')).trim();
    const size = Number.parseInt(sizeField, 8) || 0;
    const dataStart = off + 512;

    if (wanted.has(name)) return buf.subarray(dataStart, dataStart + size).toString('utf8');
    off = dataStart + Math.ceil(size / 512) * 512;
  }

  return undefined;
}

/**
 * Порядок публикации депс-фёрст: каждый следующий пакет зависит только от уже
 * опубликованных. Источник — ранбук wiki:3332 §npm publish п.4.
 */
export const PUBLISH_ORDER = [
  '@schedjs/core',
  '@schedjs/storage-mongo',
  '@schedjs/storage-mysql',
  '@schedjs/storage-postgres',
  '@schedjs/admin-api',
  '@schedjs/mcp',
  '@schedjs/ui',
  '@schedjs/daemon',
  '@schedjs/cli',
];

/**
 * Разложить волну: что публиковать, что пропустить (версия уже в реестре).
 * Идемпотентность обязательна — версия в npm неперезаписываема (gotcha 21),
 * а повторный прогон workflow после частичного падения должен просто
 * продолжить с того места, где встал.
 *
 * @param {Array<{name: string, version: string, dir: string}>} packages workspace-пакеты
 * @param {Record<string, string[]>} publishedVersions версии, уже видимые в реестре
 * @returns {{publish: Array<{name: string, version: string, dir: string}>,
 *            skip: Array<{name: string, version: string, reason: string}>,
 *            order: string[]}}
 */
export function planWave(packages, publishedVersions = {}) {
  const byName = new Map(packages.map((p) => [p.name, p]));
  const publish = [];
  const skip = [];

  for (const name of PUBLISH_ORDER) {
    const pkg = byName.get(name);
    if (!pkg) {
      skip.push({ name, version: '', reason: 'нет в workspace' });
      continue;
    }
    const seen = publishedVersions[name] ?? [];
    if (seen.includes(pkg.version)) {
      skip.push({ name, version: pkg.version, reason: 'версия уже в реестре' });
      continue;
    }
    publish.push({ ...pkg });
  }

  // Пакеты scope, которых нет в канонном порядке, не теряем молча: публикуем
  // после канонных, но помечаем в плане (сигнал, что ранбук отстал).
  const extra = packages
    .filter((p) => p.name.startsWith('@schedjs/') && !PUBLISH_ORDER.includes(p.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const pkg of extra) {
    const seen = publishedVersions[pkg.name] ?? [];
    if (seen.includes(pkg.version)) {
      skip.push({ name: pkg.name, version: pkg.version, reason: 'версия уже в реестре' });
    } else {
      publish.push({ ...pkg });
    }
  }

  return { publish, skip, order: [...PUBLISH_ORDER, ...extra.map((p) => p.name)] };
}

/**
 * Пак-чек упакованного тарбола (gotcha 18/19): `workspace:` в опубликованном
 * манифесте = пакет не поставится у пользователя (`EUNSUPPORTEDPROTOCOL`).
 * devDependencies не проверяем — в тарбол они не едут.
 *
 * @param {{dependencies?: Record<string,string>, peerDependencies?: Record<string,string>,
 *          optionalDependencies?: Record<string,string>}} manifest
 * @returns {{ok: boolean, violations: string[]}}
 */
export function assertPackedManifest(manifest) {
  const violations = [];
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = manifest?.[field] ?? {};
    for (const [dep, range] of Object.entries(deps)) {
      if (typeof range === 'string' && range.includes('workspace:')) {
        violations.push(`${field}.${dep}=${range}`);
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Разобрать `npm view <pkg> versions --json` → массив версий.
 * Пустой вывод / ошибка npm = пустой массив (пакет ещё не публиковался).
 */
export function parseNpmVersions(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text || text.includes('npm error') || text.startsWith('E404')) return [];
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'string') return [parsed];
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    return text
      .split(/\s+/)
      .map((s) => s.replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
}

/**
 * Итог инсталл-смоука: в установленном дереве не должно остаться ни одного
 * `workspace:` и ни одной нерезолвленной schedjs-зависимости.
 *
 * @param {Array<{name: string, manifest: object|null}>} installed
 * @returns {{ok: boolean, problems: string[]}}
 */
export function checkInstalled(installed) {
  const problems = [];
  for (const pkg of installed) {
    if (!pkg.manifest) {
      problems.push(`${pkg.name}: манифест не найден в node_modules`);
      continue;
    }
    const check = assertPackedManifest(pkg.manifest);
    for (const v of check.violations) problems.push(`${pkg.name}: ${v}`);
    for (const [dep, range] of Object.entries(pkg.manifest.dependencies ?? {})) {
      if (dep.startsWith('@schedjs/') && /^(file:|link:|\*$)/.test(String(range))) {
        problems.push(`${pkg.name}: нерезолвленная зависимость ${dep}=${range}`);
      }
    }
  }
  return { ok: problems.length === 0, problems };
}
