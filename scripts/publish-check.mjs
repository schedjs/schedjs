// publish-check.mjs — self-check после волны публикаций (release-hardening
// #1051, пункт 3). Прогоняется ПОСЛЕ `yarn npm publish` (bottom-up):
//   1. для каждого @schedjs/* пакета: `npm view <name>@<version> version` —
//      пакет реально долетел до npm-реестра;
//   2. для @schedjs/daemon: `docker manifest inspect <image>:<tag>` — образ
//      реально в docker registry.
// Exit 1 + список недолетевших артефактов, если хоть один не на месте.
// История: 0.11.2 дважды «не долетал» (паб упал на tsc/dist и не был замечен;
// ловили только внешней проверкой) — этот скрипт делает проверку автоматической.
//
// Usage:
//   node scripts/publish-check.mjs [--daemon-image ghcr.io/schedjs/sched-daemon]
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedArtifacts, parseNpmViewVersion, verify } from './publish-check-lib.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** npm executable: .cmd wrapper on Windows (execFileSync cannot spawn bare 'npm';
 * needs shell:true there). */
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const SPAWN_OPTS = process.platform === 'win32' ? { shell: true } : {};

/** Registry из .yarnrc.yml (npmRegistryServer) или флаг --registry; фолбэк npmjs. */
function resolveRegistry(cliRegistry) {
  if (cliRegistry) return cliRegistry;
  try {
    const yarnrc = readFileSync(join(ROOT, '.yarnrc.yml'), 'utf8');
    const m = yarnrc.match(/npmRegistryServer:\s*"([^"]+)"/);
    if (m) return m[1];
  } catch {
    // нет .yarnrc.yml — фолбэк
  }
  return 'https://registry.npmjs.org/';
}

/** Прочитать name/version всех workspace-пакетов (source of truth). */
function readWorkspacePackages() {
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const workspaces = root.workspaces ?? [];
  const pkgs = [];
  for (const w of workspaces) {
    const dir = join(ROOT, w);
    // workspaces может быть «packages/*» — раскрываем глобом вручную (простой случай)
    let dirs = [];
    if (w.includes('*')) {
      const base = w.slice(0, w.indexOf('*'));
      dirs = readdirSync(join(ROOT, base), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(ROOT, base, e.name));
    } else {
      dirs = [dir];
    }
    for (const d of dirs) {
      const pj = join(d, 'package.json');
      try {
        const p = JSON.parse(readFileSync(pj, 'utf8'));
        if (p.name) pkgs.push({ name: p.name, version: p.version });
      } catch {
        // docs/ и пр. без package.json — пропускаем
      }
    }
  }
  return pkgs;
}

function npmViewVersion(name, version, registry) {
  try {
    const out = execFileSync(NPM_BIN, ['view', `${name}@${version}`, 'version', '--registry', registry], {
      ...SPAWN_OPTS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    return parseNpmViewVersion(out, name);
  } catch {
    return undefined;
  }
}

function dockerManifestExists(image, tag) {
  try {
    execFileSync('docker', ['manifest', 'inspect', `${image}:${tag}`], {
      stdio: 'ignore',
      timeout: 60_000,
    });
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  let daemonImage = 'ghcr.io/schedjs/sched-daemon';
  let registry;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--daemon-image' && argv[i + 1]) daemonImage = argv[i + 1];
    if (argv[i] === '--registry' && argv[i + 1]) registry = argv[i + 1];
  }
  return { daemonImage, registry };
}

function main() {
  const { daemonImage, registry: cliRegistry } = parseArgs(process.argv.slice(2));
  const registry = resolveRegistry(cliRegistry);
  const packages = readWorkspacePackages();
  const expected = expectedArtifacts(packages, { daemonImage });

  const actualNpm = {};
  for (const a of expected.npm) {
    actualNpm[a.name] = npmViewVersion(a.name, a.version, registry);
  }

  const actualDocker = {};
  for (const d of expected.docker) {
    actualDocker[`${d.image}:${d.tag}`] = dockerManifestExists(d.image, d.tag);
  }

  const verdict = verify(expected, { npm: actualNpm, docker: actualDocker });

  if (verdict.ok) {
    console.log(`publish-check OK: ${expected.npm.length} npm packages + ${expected.docker.length} docker image(s) landed`);
    return 0;
  }

  console.error('publish-check FAILED — not landed:');
  for (const m of verdict.missing) {
    if (m.kind === 'npm') {
      console.error(`  npm ${m.name}@${m.expected} — got ${m.got}`);
    } else {
      console.error(`  docker ${m.image}:${m.tag} — manifest inspect failed`);
    }
  }
  return 1;
}

process.exitCode = main();
