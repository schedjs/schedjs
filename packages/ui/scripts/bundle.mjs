// Bundle the sched web components into a single self-contained ESM file the
// browser can load without an import map (lit + all components inlined).
// Also emit dist/index.html — the standalone morda shell — so a static host
// (nginx/CDN) can serve dist/ under any path (relative apiBase/bundleSrc).
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mordaHtml } from '../dist/morda.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../dist/sched-ui.bundle.js', import.meta.url)),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'info',
});

// Stale-bundle tripwire (F&F r2 lesson): a publish that ran tsc but skipped
// this script used to ship the PREVIOUS bundle — the keyed-list fix existed
// in dist/sched-runs.js but not in sched-ui.bundle.js, and the UI kept lying
// about statuses. Every sched-runs/tasks/schedules row is keyed via the lit
// `repeat` directive, so a bundle without it cannot be a fresh build.
const bundlePath = fileURLToPath(new URL('../dist/sched-ui.bundle.js', import.meta.url));
const bundle = readFileSync(bundlePath, 'utf8');
if (!bundle.includes('repeat')) {
  throw new Error(
    'stale bundle: dist/sched-ui.bundle.js does not contain the lit `repeat` directive ' +
      '(keyed lists). Rebuild is incomplete — refusing to publish a bundle that would ' +
      'desync run statuses.',
  );
}

// The morda shell: relative apiBase/bundleSrc so dist/ works when hosted at
// any mount path (e.g. under /sched). Query overrides (?api=…) still apply.
writeFileSync(
  fileURLToPath(new URL('../dist/index.html', import.meta.url)),
  mordaHtml({ apiBase: './api', bundleSrc: './sched-ui.bundle.js' }),
);
