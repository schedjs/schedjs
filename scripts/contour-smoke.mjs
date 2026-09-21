#!/usr/bin/env node
/**
 * Phase-2 gate (plan:45) — the three live scenarios on a LOCAL docker contour:
 * daemon + admin-api + sqlite, image built from this working tree
 * (deploy/Dockerfile.contour), driven by the local @schedjs/cli + a mock
 * webhook/worker on the host.
 *
 * Why a live contour: R2 (queue pause / skip-not-catch-up), R4 (run-filter
 * window) and R3 (bulk cancel/retry) are unreleased code — a registry image
 * cannot carry them, so the gate has to run the checkout inside docker, with a
 * real SQLite file surviving a real container restart.
 *
 * Scenarios
 *   1. pause → container restart → resume: no catch-up burst, the deferred
 *      `once` plays exactly once, no `missed-slot` alert for the pause window.
 *   2. "what failed in the last 24h" — one CLI command.
 *   3. bulk cancel on a mixed batch: valid + not-found + already-terminal.
 *
 * Usage:  node scripts/contour-smoke.mjs  [--keep] [--skip-build] [--fast]
 *   --keep        leave the contour running (debugging)
 *   --skip-build  reuse the existing image + CLI dist (the image must still be
 *                 stamped with HEAD — provenance is checked, never assumed)
 *   --fast        short pause window (iteration only): the missed-slot check is
 *                 then reported as NOT CHECKED, never as a pass
 * Env: CONTOUR_PORT (default 18099), CONTOUR_IMAGE (default sched-contour:local)
 *
 * Exit: 0 = all three scenarios confirmed, 1 = a scenario failed, 2 = harness error.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const IMAGE = process.env.CONTOUR_IMAGE ?? 'sched-contour:local';
const CLI = join(REPO, 'packages', 'cli', 'dist', 'index.js');
const API_KEY = 'contour-smoke-key';
const FAST = process.argv.includes('--fast');
const KEEP = process.argv.includes('--keep');
const SKIP_BUILD = process.argv.includes('--skip-build');
const CONTAINER = `sched-contour-smoke-${process.pid}`;
const RUN_DIR = join(tmpdir(), `sched-contour-${process.pid}`);

/** Pause must outlive the engine's missed-slot grace (120 s default) for the
 * silence assertion to mean anything: the deferred `once` slot has to be
 * overdue BEYOND grace at resume time, otherwise a missing suppression would
 * stay silent anyway and the check would be vacuous. */
const GRACE_MS = 120_000;
const PAUSE_BUFFER_MS = FAST ? -100_000 : 10_000; // fast: 20 s window vs 120 s grace
const ONCE_IN_MS = FAST ? 20_000 : 40_000; // pause starts at ~10 s → slot is inside the window

const log = (msg) => process.stdout.write(`${msg}\n`);
const step = (n, msg) => log(`\n=== ${n} ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

let failures = 0;
const notChecked = [];
const evidence = [];
const check = (name, ok, detail = '') => {
  log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  evidence.push({ name, ok, detail });
  if (!ok) failures += 1;
  return ok;
};
/** A scenario that cannot be judged in this mode (e.g. --fast) is neither a
 * pass nor a failure: it must not inflate the verdict. */
const skip = (name, why) => {
  log(`  SKIP ${name} — ${why}`);
  notChecked.push({ name, why });
};
const startedAtMs = (run) => new Date(run.startedAt).getTime();

function sh(cmd, args, { allowFail = false, timeoutMs = 600_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !allowFail) {
        reject(new Error(`${cmd} ${args.join(' ')} exited ${code}\n${out}\n${err}`));
        return;
      }
      resolvePromise({ code, out, err });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// --- mock host services: worker endpoints + the alert webhook --------------
const webhookPayloads = [];
const requestLog = [];
let slowAborted = 0;

function startMockServer(port) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requestLog.push({ at: nowIso(), path: url.pathname });
    if (url.pathname === '/alert') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          webhookPayloads.push({ at: new Date().toISOString(), body: JSON.parse(body) });
        } catch {
          webhookPayloads.push({ at: new Date().toISOString(), body: { raw: body } });
        }
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }
    if (url.pathname === '/fail') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('boom');
      return;
    }
    if (url.pathname === '/slow') {
      const timer = setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      }, 30_000);
      // the http runner cancels by aborting the request — that IS the
      // cancellable-run signal scenario 3 depends on
      const onAbort = () => {
        if (!res.writableEnded && !aborted) {
          aborted = true;
          slowAborted += 1;
          clearTimeout(timer);
        }
      };
      let aborted = false;
      req.on('close', onAbort);
      res.on('close', onAbort);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  return new Promise((resolvePromise) => server.listen(port, '0.0.0.0', () => resolvePromise(server)));
}

async function freePort(start) {
  for (let port = start; port < start + 200; port++) {
    const ok = await new Promise((r) => {
      const probe = createServer();
      probe.once('error', () => r(false));
      probe.once('listening', () => probe.close(() => r(true)));
      probe.listen(port, '0.0.0.0');
    });
    if (ok) return port;
  }
  throw new Error('no free port found');
}

// --- contour helpers -------------------------------------------------------
async function dockerApi(port, path, { method = 'GET', body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${API_KEY}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json, text };
}

async function waitHealth(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}

async function listRuns(port) {
  const res = await dockerApi(port, '/runs?limit=500');
  if (res.status !== 200) throw new Error(`GET /runs → ${res.status} ${res.text}`);
  return res.json.runs;
}

async function runsOf(port, task) {
  return (await listRuns(port)).filter((r) => r.taskName === task);
}

async function waitTerminal(port, runId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await dockerApi(port, `/runs/${runId}`);
    if (res.status === 200 && ['succeeded', 'failed', 'cancelled'].includes(res.json.status)) return res.json;
    await sleep(300);
  }
  throw new Error(`run ${runId} did not reach a terminal status in ${timeoutMs} ms`);
}

/** One CLI invocation — the operator path, never a hand-rolled REST call. */
async function cli(port, args) {
  return sh(process.execPath, [CLI, ...args, '--admin-url', `http://127.0.0.1:${port}/api`, '--api-key', API_KEY], {
    allowFail: true,
  });
}

// --- scenarios -------------------------------------------------------------
async function scenario1(port, onceAtMs) {
  step('1/3', 'pause → container restart → resume (no catch-up burst, once not lost, missed-slot silent)');

  const q0 = await dockerApi(port, '/queue');
  check(
    'boot state is paused-from-start (SCHED_START_PAUSED=1)',
    q0.json?.paused === true && q0.json?.startPaused === true,
    `HTTP ${q0.status} ${JSON.stringify(q0.json)}`,
  );

  await dockerApi(port, '/queue/resume', { method: 'POST' });
  await sleep(7_000);
  const beatBeforePause = await runsOf(port, 'beat');
  check('baseline: recurring task ticks while active', beatBeforePause.length >= 2, `beat runs=${beatBeforePause.length}`);

  const paused = await dockerApi(port, '/queue/pause', { method: 'POST' });
  check('POST /queue/pause → paused', paused.json?.paused === true && paused.json?.pausedAt !== null, `HTTP ${paused.status} ${JSON.stringify(paused.json)}`);
  const pauseAtMs = Date.now();
  const runsAtPause = (await listRuns(port)).length;

  log('  … restarting the container (sqlite + operator pause must survive)');
  await sh('docker', ['restart', CONTAINER]);
  check('contour healthy after restart', await waitHealth(port), 'GET /api/health');
  const qRestart = await dockerApi(port, '/queue');
  check(
    'pause survives the restart (start-paused, frozen since process start)',
    qRestart.json?.paused === true && qRestart.json?.startPaused === true,
    `HTTP ${qRestart.status} ${JSON.stringify(qRestart.json)}`,
  );

  // sit frozen well past the deferred once slot AND past the missed-slot grace
  const resumeAtMs = onceAtMs + GRACE_MS + PAUSE_BUFFER_MS;
  const frozenMs = resumeAtMs - Date.now();
  const frozenWindowStart = Date.now();
  log(`  … queue stays frozen ${Math.round(frozenMs / 1000)}s (once slot + missed-slot grace of ${GRACE_MS / 1000}s must both fall inside the window)`);
  while (Date.now() < resumeAtMs) await sleep(Math.min(5_000, Math.max(250, resumeAtMs - Date.now())));
  const frozenSeconds = (Date.now() - frozenWindowStart) / 1000;
  const runsDuringRestart = await listRuns(port);
  check(
    'nothing ran while frozen (restart is not an un-pause)',
    runsDuringRestart.length === runsAtPause,
    `runs ${runsAtPause} → ${runsDuringRestart.length} over ~${Math.round(frozenSeconds)}s`,
  );

  const resumed = await dockerApi(port, '/queue/resume', { method: 'POST' });
  const resumedAtMs = Date.now();
  check('POST /queue/resume → active', resumed.json?.paused === false, `HTTP ${resumed.status} ${JSON.stringify(resumed.json)}`);
  await sleep(8_000);

  const onceRuns = await runsOf(port, 'once-late');
  check('deferred `once` played exactly once (not lost, not duplicated)', onceRuns.length === 1, `once-late runs=${onceRuns.length}`);
  check('the deferred run succeeded', onceRuns[0]?.status === 'succeeded', `status=${onceRuns[0]?.status ?? 'n/a'}`);

  // Two independent burst probes on the recurring task: (a) the frozen window
  // itself must contain ZERO runs (a catch-up replay would backfill it), and
  // (b) after resume the cadence must be the task's own (≈1 per 2s), not a
  // queue drain. Both use startedAt, so the phases cannot be confused.
  const beatRuns = await runsOf(port, 'beat');
  const frozenRunIds = beatRuns.filter((r) => startedAtMs(r) >= pauseAtMs && startedAtMs(r) <= resumedAtMs);
  check(
    'no run started inside the frozen window (no catch-up replay)',
    frozenRunIds.length === 0,
    `beat runs started between pause and resume=${frozenRunIds.length} over ${Math.round((resumedAtMs - pauseAtMs) / 1000)}s`,
  );
  const afterResume = beatRuns.filter((r) => startedAtMs(r) > resumedAtMs);
  const expectedAfterResume = Math.ceil((Date.now() - resumedAtMs) / 2000) + 2;
  check(
    'after resume the recurring task keeps its cadence (no drain)',
    afterResume.length >= 1 && afterResume.length <= expectedAfterResume,
    `beat runs after resume=${afterResume.length} (≤${expectedAfterResume} expected, a drain would be ≈${Math.round(frozenSeconds / 2)})`,
  );

  return { frozenSeconds, skippedSlots: Math.round(frozenSeconds / 2), resumeAtMs, pauseAtMs, resumedAtMs };
}

async function scenario2(port) {
  step('2/3', '"what failed in the last 24h" — one CLI command');
  const triggered = await dockerApi(port, '/tasks/flaky/run', { method: 'POST' });
  check('ad-hoc trigger accepted', triggered.status === 200, `HTTP ${triggered.status}`);
  const failedRun = await waitTerminal(port, triggered.json.run.id);
  check('flaky task produced a failed run', failedRun.status === 'failed', `status=${failedRun.status}`);

  const cmd = ['runs', '--status', 'failed', '--since', '24h', '--json'];
  const res = await cli(port, cmd);
  let parsed = null;
  try {
    parsed = JSON.parse(res.out);
  } catch {
    /* reported by the check below */
  }
  check('one CLI command answers the question', res.code === 0 && parsed !== null, `sched ${cmd.join(' ')} → exit ${res.code}${parsed ? '' : ` out=${res.out.slice(0, 200)}`}`);
  check(
    'the failed run is in the window',
    parsed?.runs?.some((r) => r.id === failedRun.id) === true,
    `runs=${parsed?.runs?.length ?? 'n/a'}, ids=${parsed?.runs?.map((r) => r.id).join(',') || '—'}`,
  );
  check(
    'window resolved to ISO (24h ago → now) and status pinned',
    typeof parsed.filter?.since === 'string' && parsed.filter?.status === 'failed',
    JSON.stringify(parsed.filter),
  );
  const human = await cli(port, ['runs', '--status', 'failed', '--since', '24h']);
  log(`  operator view:\n${human.out.trimEnd().split('\n').map((l) => `    ${l}`).join('\n')}`);
  return { failedRun: failedRun.id, human, since: parsed.filter.since };
}

async function scenario3(port, terminalRunId) {
  step('3/3', 'bulk cancel on a mixed batch (valid + not-found + already-terminal)');
  // A sync runner's POST /tasks/:name/run answers only when the run is over,
  // so the trigger is fired in the background and the RUNNING run is picked
  // off the listing — that is what an operator cancels in real life.
  const pendingTrigger = dockerApi(port, '/tasks/slow/run', { method: 'POST' }).then(
    (r) => r,
    (e) => ({ error: String(e) }),
  );
  let validId = null;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && validId === null) {
    const running = (await runsOf(port, 'slow')).find((r) => r.status === 'running' || r.status === 'queued');
    if (running) validId = running.id;
    else await sleep(250);
  }
  check('slow run is in flight (running, cancellable)', validId !== null, `id=${validId}`);
  if (validId === null) throw new Error('no running slow run to cancel');
  const missingId = 'run-does-not-exist-0001';

  const cmd = ['cancel', validId, missingId, terminalRunId, '--json'];
  const res = await cli(port, cmd);
  let parsed = null;
  try {
    parsed = JSON.parse(res.out);
  } catch {
    /* reported below */
  }
  check('CLI exits 1 on a partial batch', res.code === 1, `sched ${cmd.join(' ')} → exit ${res.code}`);
  check('valid id cancelled', parsed?.ok?.length === 1 && parsed.ok[0] === validId, JSON.stringify(parsed?.ok));
  check(
    'not-found reported as not-found',
    parsed?.failed?.some((f) => f.id === missingId && f.reason === 'not-found'),
    JSON.stringify(parsed?.failed),
  );
  check(
    'terminal run reported as already-terminal',
    parsed?.failed?.some((f) => f.id === terminalRunId && f.reason === 'already-terminal'),
    JSON.stringify(parsed?.failed),
  );
  const cancelled = await dockerApi(port, `/runs/${validId}`);
  check('the cancelled run is terminal in storage', cancelled.json?.status === 'cancelled', `status=${cancelled.json?.status}`);
  check('the worker saw the cancel (request aborted)', slowAborted >= 1, `aborted=${slowAborted}`);
  const triggerSettled = await pendingTrigger;
  check(
    'the blocking trigger call came back with the cancelled run',
    triggerSettled?.json?.run?.status === 'cancelled',
    `status=${triggerSettled?.json?.run?.status ?? triggerSettled?.error}`,
  );
  return { validId, missingId, terminalRunId, out: parsed };
}

async function assertAlertChannel({ fast }) {
  step('alerts', 'webhook channel: positive control + missed-slot silence');
  const events = webhookPayloads.map((p) => p.body?.event);
  const missed = events.filter((e) => e === 'missed-slot').length;
  const failedAlerts = events.filter((e) => e === 'run.failed').length;
  check('webhook channel is live (run.failed delivered)', failedAlerts >= 1, `events=${JSON.stringify(events)}`);
  const name = 'no missed-slot alert for the pause window (slot was overdue beyond grace)';
  if (fast) {
    // Below the engine's 120 s default grace a missing suppression stays silent
    // anyway — asserting silence here would "prove" nothing. Not checked beats
    // a fake pass.
    skip(name, `--fast pause window is shorter than the ${GRACE_MS / 1000}s missed-slot grace`);
  } else {
    check(name, missed === 0, `missed-slot payloads=${missed} of ${events.length} alert(s)`);
  }
}

// --- main ------------------------------------------------------------------
async function main() {
  if (typeof fetch !== 'function') throw new Error('this gate needs a Node with global fetch (>= 21; the repo requires >= 24)');
  const port = Number(process.env.CONTOUR_PORT ?? 0) || (await freePort(18099));
  const mockPort = await freePort(port + 1);
  mkdirSync(RUN_DIR, { recursive: true });
  const mock = await startMockServer(mockPort);
  const hostBase = `http://host.docker.internal:${mockPort}`;
  const head = (await sh('git', ['-C', REPO, 'rev-parse', 'HEAD'])).out.trim();
  log(`contour smoke — repo=${REPO}  HEAD=${head}\n  image=${IMAGE}  admin=http://127.0.0.1:${port}/api  mock=${hostBase}  runDir=${RUN_DIR}`);

  try {
    if (!SKIP_BUILD) {
      log('\n=== build  local cli dist (host) + contour image (from this working tree)');
      await sh(process.execPath, [join(REPO, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(REPO, 'packages', 'cli', 'tsconfig.build.json')]);
      check('local CLI built from source', existsSync(CLI), CLI);
      const build = await sh(
        'docker',
        [
          'build',
          '--build-arg', `GIT_SHA=${head}`,
          '-f', join(REPO, 'deploy', 'Dockerfile.contour').replace(/\\/g, '/'),
          '-t', IMAGE,
          REPO,
        ],
        { timeoutMs: 900_000 },
      );
      check('contour image built from the working tree', build.code === 0);
    }

    // Provenance gate: the image has to BE the tree under test. Without this,
    // `--skip-build` (or a cached tag) could certify a stale artifact.
    const stamped = (await sh('docker', ['inspect', '-f', '{{index .Config.Labels "org.sched.contour.sha"}}', IMAGE])).out.trim();
    if (!check('contour image carries the HEAD sha (grade the artifact under test, not a stale one)', stamped === head, `image=${stamped} HEAD=${head}`)) {
      throw new Error(`refusing to certify: image ${IMAGE} was built from ${stamped || '<unlabelled>'}, working tree is ${head}`);
    }

    const onceAtMs = Date.now() + ONCE_IN_MS;
    const tasksJson = {
      tasks: [
        { name: 'beat', runner: 'http', label: 'recurring probe', config: { url: `${hostBase}/ok` }, schedules: [{ interval: 'every 2 seconds' }] },
        { name: 'once-late', runner: 'http', label: 'deferred one-shot', config: { url: `${hostBase}/ok` }, schedules: [{ once: new Date(onceAtMs).toISOString() }] },
        { name: 'flaky', runner: 'http', label: 'always fails', config: { url: `${hostBase}/fail` } },
        { name: 'slow', runner: 'http', label: 'long-running (cancellable)', timeoutMs: 120_000, config: { url: `${hostBase}/slow` } },
      ],
      alerts: { webhook: { url: `${hostBase}/alert` }, onMissed: true },
    };
    writeFileSync(join(RUN_DIR, 'tasks.json'), JSON.stringify(tasksJson, null, 2));
    log(`  once-late slot: ${new Date(onceAtMs).toISOString()} (pause covers it; restart sits inside the window)`);

    const run = await sh('docker', [
      'run', '-d', '--name', CONTAINER,
      '-p', `127.0.0.1:${port}:8080`,
      '--add-host', 'host.docker.internal:host-gateway',
      '-v', `${join(RUN_DIR, 'tasks.json')}:/app/tasks.json:ro`,
      '-e', `SCHED_ADMIN_KEY=${API_KEY}`,
      '-e', 'SCHED_START_PAUSED=1',
      IMAGE,
      '--tasks', '/app/tasks.json', '--db', '/data/sched.db',
      '--admin-port', '8080', '--admin-host', '0.0.0.0', '--tick-interval', '1000',
    ]);
    if (run.code !== 0) throw new Error(`docker run failed: ${run.err}`);
    check('contour up (daemon + admin api + sqlite)', await waitHealth(port), `docker logs:\n${(await sh('docker', ['logs', '--tail', '20', CONTAINER])).out}`);

    const s1 = await scenario1(port, onceAtMs);
    const s2 = await scenario2(port);
    const s3 = await scenario3(port, s2.failedRun);
    await assertAlertChannel({ fast: FAST });

    log('\n=== evidence');
    log(JSON.stringify({
      scenario1: {
        pauseWindowSeconds: Math.round(s1.frozenSeconds),
        skippedRecurringSlots: s1.skippedSlots,
        pausedAt: new Date(s1.pauseAtMs).toISOString(),
        resumedAt: new Date(s1.resumedAtMs).toISOString(),
      },
      scenario2: { failedRun: s2.failedRun, since: s2.since, command: 'sched runs --status failed --since 24h' },
      scenario3: s3.out,
      alerts: webhookPayloads.map((p) => ({ at: p.at, event: p.body?.event, task: p.body?.task?.name })),
      requests: requestLog,
      image: { tag: IMAGE, sha: head },
      checks: evidence.length,
      failed: failures,
      notChecked,
    }, null, 2));
  } finally {
    if (!KEEP) {
      await sh('docker', ['rm', '-f', CONTAINER], { allowFail: true });
      rmSync(RUN_DIR, { recursive: true, force: true });
      mock.close();
    } else {
      log(`\n--keep: contour ${CONTAINER} left running (admin http://127.0.0.1:${port}/api, key ${API_KEY}), run dir ${RUN_DIR}`);
    }
  }

  const skipped = notChecked.length > 0 ? `, ${notChecked.length} not checked (${notChecked.map((n) => n.name).join('; ')})` : '';
  log(`\n${failures === 0 ? 'GATE PASS' : `GATE FAIL (${failures} check(s))`} — ${evidence.length - failures}/${evidence.length} checks passed${skipped}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  log(`\nharness error: ${err?.stack ?? err}`);
  process.exit(failures > 0 ? 1 : 2);
});
