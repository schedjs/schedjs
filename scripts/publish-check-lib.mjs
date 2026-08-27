// publish-check-lib.mjs — чистая логика self-check публикации (release-hardening
// #1051, пункт 3). Отделена от I/O (npm view / docker manifest), чтобы
// тестироваться юнитами без сети. Сам CLI — publish-check.mjs.
//
// Проблема, которую закрываем: 0.11.2 дважды «не долетал» — паб упал на
// tsc/dist и не был замечен, артефакты ловили только внешней проверкой.
// После волны публикаций этот скрипт должен прогоняться автоматически:
// каждый @schedjs/* пакет реально виден в npm на заявленной версии, daemon-образ
// — в docker registry.

/**
 * Версии пакетов, заявленные в workspace (source of truth — package.json).
 * @param {Array<{name?: string, version?: string}>} packages
 * @param {{daemonImage: string}} opts
 */
export function expectedArtifacts(packages, opts) {
  const npm = packages
    .filter((p) => p.name && p.version)
    .map((p) => ({ name: p.name, version: p.version }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const daemon = packages.find((p) => p.name === '@schedjs/daemon');
  const docker = daemon?.version ? [{ image: opts.daemonImage, tag: daemon.version }] : [];
  return { npm, docker };
}

/**
 * Распарсить stdout `npm view <pkg>@<ver> version`: чистая строка версии = пакет
 * долетел; пусто / npm error (E404, EAI_AGAIN, …) = не долетел.
 */
export function parseNpmViewVersion(stdout, _name) {
  const line = stdout.trim();
  if (!line) return undefined;
  if (line.includes('npm error')) return undefined;
  return line;
}

/**
 * Сверить фактическое состояние реестра (что вернули npm view / docker
 * manifest inspect) с ожидаемыми артефактами. Версия из реестра должна
 * совпадать 1:1 — semver-нечёткое сравнение не допускается (артефакт либо
 * долетел точно, либо нет).
 */
export function verify(expected, actual) {
  const missing = [];

  for (const a of expected.npm) {
    const got = actual.npm[a.name];
    if (got !== a.version) {
      missing.push({ kind: 'npm', name: a.name, expected: a.version, got: got ?? '(not found)' });
    }
  }

  for (const d of expected.docker) {
    const key = `${d.image}:${d.tag}`;
    if (actual.docker[key] !== true) {
      missing.push({ kind: 'docker', image: d.image, tag: d.tag });
    }
  }

  return { ok: missing.length === 0, missing };
}
