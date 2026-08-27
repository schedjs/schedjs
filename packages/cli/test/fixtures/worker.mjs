/**
 * Fixture worker — a conformant HTTP envelope worker (wire contract:
 * packages/core/src/runners/http.ts + docs/content/docs/05.protocol.md).
 * Used by the check-worker tests: the validator is pointed at THIS server and
 * the 6 conformance scenarios run against it.
 *
 * Endpoints:
 *   POST /ping       sync: data.fail → {status:"failed", error}; else
 *                    {status:"succeeded", result:{pong:true}}
 *   POST /long       async: 202 {status:"accepted", statusUrl, pollIntervalMs};
 *                    GET /status/:runId → running with growing progress → succeeded
 *   POST /dirty      responds 400 { error: 'bad json' } to a garbage body
 *                    (robust worker: never crashes on malformed input)
 *
 * Conformance behavior:
 *   - run-id dedup: x-sched-run-id → in-memory map; a repeat dispatch with the
 *     same run id returns the cached terminal envelope (idempotency contract).
 *   - auth: when options.apiKey is set, every request must carry
 *     `x-sched-api-key: <key>` (401 otherwise).
 *
 * Negative-test switches (constructor options):
 *   - apiKey          → auth scenario
 *   - hangAsync: true → /long never progresses (async timeout trap)
 *   - brokenSync: true→ /ping answers {status:"succeeded"} even with data.fail
 *                    (lets tests see a FAIL verdict)
 */
import { createServer } from 'node:http';

export function createWorkerFixture(options = {}) {
  const apiKey = options.apiKey ?? process.env.SCHED_API_KEY ?? null;
  /** @type {Map<string, object>} runId → terminal envelope (dedup cache) */
  const done = new Map();
  /** @type {Map<string, number>} runId → poll counter (progress growth) */
  const polls = new Map();

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const runId = req.headers['x-sched-run-id'] ?? '';

    if (apiKey && req.headers['x-sched-api-key'] !== apiKey) {
      return json(res, 401, { error: 'unauthorized' });
    }

    let body = {};
    if (req.method === 'POST') {
      body = await new Promise((resolve) => {
        let data = '';
        req.on('data', (c) => (data += c));
        req.on('end', () => {
          try {
            resolve(data ? JSON.parse(data) : {});
          } catch {
            resolve(null); // garbage body
          }
        });
      });
    }

    // Async status polling
    if (req.method === 'GET' && path.startsWith('/status/')) {
      const id = path.slice('/status/'.length);
      const counter = (polls.get(id) ?? 0) + 1;
      polls.set(id, counter);
      if (options.hangAsync || counter < 3) {
        return json(res, 200, { status: 'running', progress: Math.min(0.9, counter * 0.3), log: `step ${counter}` });
      }
      done.set(id, { status: 'succeeded', result: { done: true, polls: counter } });
      return json(res, 200, done.get(id));
    }

    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

    // Garbage body → robust worker answers 400, process stays alive
    if (body === null) {
      return json(res, 400, { error: 'bad json' });
    }

    if (path === '/long') {
      if (done.has(runId)) return json(res, 200, done.get(runId));
      return json(res, 202, {
        status: 'accepted',
        statusUrl: `http://127.0.0.1:${server.address().port}/status/${runId}`,
        pollIntervalMs: 10,
      });
    }

    // /ping (default sync path)
    if (done.has(runId)) return json(res, 200, done.get(runId));
    const data = body.data ?? {};
    if (data.fail) {
      if (options.brokenSync) {
        // broken worker: reports succeeded even when the task should fail
        return json(res, 200, { status: 'succeeded', result: { pong: true } });
      }
      const env = { status: 'failed', error: 'worker boom' };
      done.set(runId, env);
      return json(res, 200, env);
    }
    const env = { status: 'succeeded', result: { pong: true } };
    done.set(runId, env);
    return json(res, 200, env);
  });

  const listen = () =>
    new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });

  return {
    server,
    listen,
    port: () => server.address().port,
    close: () => new Promise((r) => server.close(r)),
  };
}
