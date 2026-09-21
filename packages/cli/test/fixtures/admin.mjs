/**
 * Fixture admin API — scriptable stand-in for the sched admin REST API
 * (real contract: packages/core/src/admin-api.ts; mounted at /api by the
 * daemon). The @schedjs/cli contract tests spawn the CLI against THIS server
 * and assert on exit codes + JSON — no real daemon involved.
 *
 * Native routes (no /api prefix — the CLI test passes --admin-url at root):
 *   GET    /health                 → { ok, uptimeMs, version }
 *   GET    /queue                  → { paused, pausedAt, startPaused }
 *   GET    /runs?task&status&limit&offset → { runs }
 *   POST   /runs/bulk/cancel|retry { ids } → { ok, failed:[{id,reason}] }
 *   GET    /tasks                  → { tasks }
 *   GET    /schedules              → { schedules }
 *   GET    /schedules/:id          → schedule | 404
 *   POST   /tasks/:name/run        → { run }
 *   POST   /tasks/:name/pause|resume → { ok: true }
 *   POST   /schedules/:id/pause|resume → { ok: true }
 *
 * Control endpoints (not part of the API under test):
 *   POST   /__seed   { tasks?, runs?, schedules? } → replace state
 *   POST   /__reset  → clear state + request log
 *   GET    /__requests → [{ method, path, auth }]  (in arrival order)
 *
 * Auth: when FIXTURE_KEY is set, every request must carry
 * `Authorization: Bearer <FIXTURE_KEY>` (else 401 { error: 'unauthorized' }).
 */
import { createServer } from 'node:http';

export function createAdminFixture({ key } = {}) {
  let state = { tasks: [], runs: [], schedules: [], queue: { paused: false, pausedAt: null, startPaused: false } };
  /** @type {Array<{method: string, path: string, auth: boolean}>} */
  let requests = [];

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req) =>
    new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          resolve({});
        }
      });
    });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const auth = (req.headers.authorization ?? '').startsWith('Bearer ');
    requests.push({ method, path: url.pathname + url.search, auth });

    if (key && req.headers.authorization !== `Bearer ${key}`) {
      return json(res, 401, { error: 'unauthorized' });
    }

    // --- control ---
    if (path === '/__seed' && method === 'POST') {
      const body = await readBody(req);
      state = {
        tasks: body.tasks ?? [],
        runs: body.runs ?? [],
        schedules: body.schedules ?? [],
        queue: body.queue ?? { paused: false, pausedAt: null, startPaused: false },
      };
      return json(res, 200, { ok: true });
    }
    if (path === '/__reset' && method === 'POST') {
      state = { tasks: [], runs: [], schedules: [], queue: { paused: false, pausedAt: null, startPaused: false } };
      requests = [];
      return json(res, 200, { ok: true });
    }
    if (path === '/__requests' && method === 'GET') {
      return json(res, 200, { requests });
    }

    // --- health ---
    if (method === 'GET' && path === '/health') {
      return json(res, 200, { ok: true, uptimeMs: 4242, version: '9.9.9-fixture' });
    }

    // --- queue ---
    if (method === 'GET' && path === '/queue') {
      return json(res, 200, state.queue);
    }

    // --- bulk cancel/retry (R3) ---
    const bulkMatch = path.match(/^\/runs\/bulk\/(cancel|retry)$/);
    if (bulkMatch && method === 'POST') {
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids : [];
      const ok = [];
      const failed = [];
      const terminal = ['succeeded', 'failed', 'cancelled'];
      for (const id of ids) {
        const run = state.runs.find((r) => r.id === id);
        if (!run) {
          failed.push({ id, reason: 'not-found' });
          continue;
        }
        if (bulkMatch[1] === 'cancel') {
          if (terminal.includes(run.status)) {
            failed.push({ id, reason: 'already-terminal' });
            continue;
          }
          run.status = 'cancelled';
          run.finishedAt = new Date().toISOString();
          ok.push(id);
          continue;
        }
        // retry — mirror the admin API: a fresh queued run linked to the original
        state.runs = [
          { ...run, id: `${id}-retry`, status: 'queued', retryOf: id, finishedAt: null, startedAt: new Date().toISOString() },
          ...state.runs,
        ];
        ok.push(id);
      }
      return json(res, 200, { ok, failed });
    }

    // --- runs ---
    if (method === 'GET' && path === '/runs') {
      let runs = state.runs;
      const task = url.searchParams.get('task');
      if (task !== null) runs = runs.filter((r) => r.taskName === task);
      const status = url.searchParams.get('status');
      if (status !== null) runs = runs.filter((r) => r.status === status);
      const limit = Number(url.searchParams.get('limit'));
      const offset = Number(url.searchParams.get('offset') ?? '0');
      if (Number.isFinite(offset) && offset > 0) runs = runs.slice(offset);
      if (Number.isFinite(limit) && limit > 0) runs = runs.slice(0, limit);
      return json(res, 200, { runs });
    }

    // --- tasks ---
    if (method === 'GET' && path === '/tasks') {
      return json(res, 200, { tasks: state.tasks });
    }

    // --- schedules ---
    if (method === 'GET' && path === '/schedules') {
      // limit/offset honored when present (the real endpoint paginates; a client
      // that aggregates a per-task total must page, or it silently undercounts).
      let schedules = state.schedules;
      const offset = Number(url.searchParams.get('offset') ?? '0');
      if (Number.isFinite(offset) && offset > 0) schedules = schedules.slice(offset);
      const limit = Number(url.searchParams.get('limit'));
      if (Number.isFinite(limit) && limit > 0) schedules = schedules.slice(0, limit);
      return json(res, 200, { schedules });
    }
    const scheduleAction = path.match(/^\/schedules\/([^/]+)\/(pause|resume)$/);
    if (scheduleAction && method === 'POST') {
      const id = decodeURIComponent(scheduleAction[1]);
      const sched = state.schedules.find((s) => s.id === id);
      if (!sched) return json(res, 404, { error: `schedule ${id} not found` });
      return json(res, 200, { ok: true });
    }
    const scheduleMatch = path.match(/^\/schedules\/([^/]+)$/);
    if (scheduleMatch && method === 'GET') {
      const id = decodeURIComponent(scheduleMatch[1]);
      const sched = state.schedules.find((s) => s.id === id);
      if (!sched) return json(res, 404, { error: `schedule ${id} not found` });
      return json(res, 200, sched);
    }

    // --- tasks mutations ---
    const taskAction = path.match(/^\/tasks\/([^/]+)\/(run|pause|resume)$/);
    if (taskAction && method === 'POST') {
      const name = decodeURIComponent(taskAction[1]);
      const action = taskAction[2];
      const task = state.tasks.find((t) => t.name === name);
      if (!task) return json(res, 404, { error: `task ${name} not found` });
      if (action === 'run') {
        const body = await readBody(req);
        const run = {
          id: `run-${state.runs.length + 1}`,
          taskName: name,
          runner: task.runner ?? 'http',
          startedAt: new Date().toISOString(),
          finishedAt: null,
          status: 'queued',
          data: body.data ?? null,
          result: null,
          error: null,
          progress: null,
          log: null,
          artifacts: null,
          workerRef: null,
          attempt: 1,
          trigger: 'manual',
          triggeredBy: null,
          scheduleId: null,
          temporary: false,
          retryOf: null,
        };
        state.runs = [run, ...state.runs];
        return json(res, 200, { run });
      }
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'not found' });
  });

  const listen = () =>
    new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve(addr.port);
      });
    });

  return {
    server,
    listen,
    seed: (s) => {
      state = { tasks: [], runs: [], schedules: [], queue: { paused: false, pausedAt: null, startPaused: false }, ...s };
    },
    clearLog: () => {
      requests = [];
    },
    requests: () => requests,
    close: () => new Promise((r) => server.close(r)),
  };
}
