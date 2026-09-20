// release-npm.mjs — публикация волны @schedjs/* без токена (trusted publishing/OIDC, task:3130).
// Прогоняется release-workflow'ом .github/workflows/release-npm.yml на runner'е
// GitHub Actions (Node 24 → npm 11.x, `id-token: write`), но полностью работает
// и локально в режиме проверки (по умолчанию — dry-run, публикации нет).
//
// Почему так, а не `yarn npm publish` (как в ранбуке wiki:3332): OIDC-trusted
// publishing поддерживает `npm publish`, а `yarn npm publish` — нет. При этом
// `workspace:*` разворачивает именно yarn-упаковщик (`yarn pack`), поэтому
// связка: `yarn pack` (депс-фёрст по волне) → пак-чек манифеста → `npm publish <tgz>`.
//
// Usage:
//   node scripts/release-npm.mjs                 # dry-run: упаковать + пак-чек + инсталл-смоук
//   node scripts/release-npm.mjs --publish       # реальная публикация (только в CI, OIDC)
//   node scripts/release-npm.mjs --only=core,cli # подмножество волны (имена без scope или с ним)
//   node scripts/release-npm.mjs --skip-smoke    # без инсталл-смоука
//   node scripts/release-npm.mjs --rehearse      # репетиция: упаковать и проверить ВСЕ пакеты scope,
//                                                # даже уже опубликованные (публикации нет никогда)
//   node scripts/release-npm.mjs --registry=https://registry.npmjs.org
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLISH_ORDER, assertPackedManifest, checkInstalled, parseNpmVersions, planWave, readTarEntry } from './release-npm-lib.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const IS_WIN = process.platform === 'win32';
const NPM = IS_WIN ? 'npm.cmd' : 'npm';
const YARN = IS_WIN ? 'yarn.cmd' : 'yarn';
const SPAWN = IS_WIN ? { shell: true } : {};

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(`--${name}`);
const valueOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const PUBLISH = hasFlag('publish');
const REHEARSE = hasFlag('rehearse');
const SKIP_SMOKE = hasFlag('skip-smoke');
const REGISTRY = valueOf('registry', 'https://registry.npmjs.org');
const ONLY = valueOf('only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => (s.startsWith('@') ? s : s.startsWith('@schedjs/') ? s : `@schedjs/${s}`));

const log = (...a) => console.log(...a);
const run = (bin, argv, opts = {}) => execFileSync(bin, argv, { encoding: 'utf8', ...SPAWN, ...opts });

/** Прочитать name/version всех workspace-пакетов (packages/*, apps/*). */
function readWorkspacePackages() {
  const out = [];
  for (const group of ['packages', 'apps']) {
    for (const dir of readdirSync(join(ROOT, group))) {
      try {
        const manifest = JSON.parse(readFileSync(join(ROOT, group, dir, 'package.json'), 'utf8'));
        if (manifest.name && manifest.version) out.push({ name: manifest.name, version: manifest.version, dir: join(group, dir) });
      } catch {
        // нет package.json — не воркспейс
      }
    }
  }
  return out;
}

/** Версии пакета в реестре (пусто = не публиковался / недоступен). */
function publishedVersions(name) {
  try {
    return parseNpmVersions(run(NPM, ['view', name, 'versions', '--json', `--registry=${REGISTRY}`]));
  } catch {
    return [];
  }
}

const slug = (name) => name.replace('@', '').replace('/', '-');

function main() {
  const npmVersion = run(NPM, ['-v']).trim();
  log(`npm ${npmVersion} · node ${process.version} · registry ${REGISTRY} · режим ${PUBLISH ? 'ПУБЛИКАЦИЯ' : REHEARSE ? 'репетиция (без публикации)' : 'dry-run'}`);
  const [maj, min] = npmVersion.split('.').map(Number);
  if (maj < 11 || (maj === 11 && min < 10)) {
    log(`::warning::npm ${npmVersion} < 11.10 — trusted publishing (npm trust) недоступен; публикация по OIDC может не сработать`);
  }

  if (PUBLISH && REHEARSE) {
    log('::error::--publish и --rehearse вместе не имеют смысла (репетиция публикует никогда)');
    process.exit(1);
  }

  if (PUBLISH && process.env.NODE_AUTH_TOKEN) {
    // Пустой/чужой токен ломает OIDC-обмен: npm предпочтёт токен и упадёт на правах.
    log('::error::NODE_AUTH_TOKEN задан — он перебивает OIDC. Уберите токен из env (в workflow его быть не должно).');
    process.exit(1);
  }

  const packages = readWorkspacePackages();
  const published = {};
  // Репетиция: делаем вид, что реестр пуст — тогда в план попадают все пакеты
  // scope (пак-чек + инсталл-смоук без единой публикации).
  if (!REHEARSE) {
    for (const pkg of packages.filter((p) => p.name.startsWith('@schedjs/'))) published[pkg.name] = publishedVersions(pkg.name);
  }

  let { publish, skip } = planWave(packages, published);
  if (ONLY.length) {
    publish = publish.filter((p) => ONLY.includes(p.name));
    skip = skip.filter((p) => ONLY.includes(p.name) || p.reason !== 'нет в workspace');
  }

  log('\n== план волны');
  for (const p of publish) log(`  publish  ${p.name}@${p.version}  (${p.dir})`);
  for (const s of skip) log(`  skip     ${s.name}${s.version ? `@${s.version}` : ''} — ${s.reason}`);
  if (publish.length === 0) {
    log('\nнечего публиковать — все версии волны уже в реестре');
    return;
  }

  const work = mkdtempSync(join(tmpdir(), 'sched-release-'));
  const tarballs = [];
  try {
    for (const pkg of publish) {
      const tgz = join(work, `${slug(pkg.name)}.tgz`);
      log(`\n== pack ${pkg.name}@${pkg.version}`);
      run(YARN, ['pack', '--out', tgz], { cwd: join(ROOT, pkg.dir) });
      const packed = readTarEntry(readFileSync(tgz), 'package/package.json');
      if (!packed) throw new Error(`${pkg.name}: в тарболе нет package/package.json`);
      const manifest = JSON.parse(packed);
      if (manifest.version !== pkg.version) {
        throw new Error(`${pkg.name}: в тарболе версия ${manifest.version}, ожидалась ${pkg.version}`);
      }
      const check = assertPackedManifest(manifest);
      if (!check.ok) throw new Error(`${pkg.name}: пак-чек провален — ${check.violations.join(', ')} (gotcha 18: workspace: не едет в реестр)`);
      log(`  ok: workspace: 0, files=${JSON.stringify(manifest.files ?? [])}`);
      tarballs.push({ pkg, tgz, manifest });
    }

    if (PUBLISH) {
      for (const t of tarballs) {
        log(`\n== publish ${t.pkg.name}@${t.pkg.version} (OIDC)`);
        run(NPM, ['publish', t.tgz, '--access', 'public', `--registry=${REGISTRY}`]);
        const got = publishedVersions(t.pkg.name);
        if (!got.includes(t.pkg.version)) throw new Error(`${t.pkg.name}@${t.pkg.version}: после publish версии нет в реестре (не судить по packument'у — читать version-документ/список версий; gotcha 20)`);
        log(`  verified: ${t.pkg.name}@${t.pkg.version} виден в реестре`);
      }
    } else {
      log('\n== publish пропущен (dry-run)');
    }

    if (!SKIP_SMOKE) {
      log('\n== install-smoke из тарболов (чистая папка, отдельный кэш)');
      const smoke = join(work, 'smoke');
      const cache = join(work, 'npm-cache');
      mkdirSync(smoke, { recursive: true });
      writeFileSync(join(smoke, 'package.json'), JSON.stringify({ name: 'release-smoke', private: true, version: '0.0.0' }, null, 2));
      run(NPM, ['install', '--no-audit', '--no-fund', `--cache=${cache}`, `--registry=${REGISTRY}`, ...tarballs.map((t) => t.tgz)], { cwd: smoke });

      const installed = tarballs.map((t) => {
        const manifestPath = join(smoke, 'node_modules', ...t.pkg.name.split('/'), 'package.json');
        let manifest = null;
        try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { /* нет манифеста */ }
        return { name: t.pkg.name, manifest };
      });
      const verdict = checkInstalled(installed);
      if (!verdict.ok) throw new Error(`install-smoke провален: ${verdict.problems.join('; ')}`);

      // Инлайн `-e` через shell на Windows ломается (`=>` читается как редирект) — пишем файл.
      const probe = join(smoke, 'probe-core.mjs');
      writeFileSync(probe, "const m = await import('@schedjs/core');\nconsole.log(Object.keys(m).length);\n");
      const coreExports = run('node', [probe], { cwd: smoke }).trim();
      log(`  @schedjs/core экспортов: ${coreExports}`);
      if (Number(coreExports) < 1) throw new Error('install-smoke: @schedjs/core не импортируется');
      for (const bin of ['schedd', 'sched']) {
        const out = run(join(smoke, 'node_modules', '.bin', IS_WIN ? `${bin}.cmd` : bin), ['--help'], { cwd: smoke });
        if (!/usage|Usage|--help/i.test(out)) throw new Error(`install-smoke: ${bin} --help не ответил`);
        log(`  ${bin} --help: ok`);
      }
    }
    log('\nГОТОВО');
  } finally {
    if (!hasFlag('keep')) rmSync(work, { recursive: true, force: true });
    else log(`\nартефакты оставлены: ${work}`);
  }
}

export { PUBLISH_ORDER };
main();
