/**
 * check-worker — conformance validator for HTTP envelope workers (wire
 * contract: packages/core/src/runners/http.ts + docs/content/docs/05.protocol.md).
 *
 * A fake-sched client: it sends exactly the envelopes sched sends and checks
 * the worker's answers. Six scenarios, PASS/FAIL verdict, exit 0 all-green /
 * 1 a scenario failed / 2 usage (handled by the dispatcher). It never touches
 * the daemon or the admin API — this is a wire-protocol validator, not a
 * control plane.
 */

export interface ScenarioResult {
  name: string;
  pass: boolean;
  skipped?: boolean;
  detail: string;
}

export interface CheckWorkerOptions {
  /** Worker base URL, e.g. http://127.0.0.1:8080 */
  url: string;
  /** Worker secret (SCHED_API_KEY on the worker side) — enables the auth scenario. */
  apiKey: string | undefined;
  /** Per-request timeout, ms. Default: 30 s. */
  timeoutMs?: number;
  /** Async lifecycle poll deadline, ms. Default: 30 s. */
  pollDeadlineMs?: number;
}

interface WireResponse {
  ok: boolean;
  status: number;
  text: string;
  /** Parsed envelope (null when the body is not a JSON envelope). */
  envelope: Record<string, unknown> | null;
  error?: string;
}

const SCENARIO_NAMES = {
  sync: 'sync success',
  syncFail: 'sync failure',
  async: 'async lifecycle',
  auth: 'auth',
  dedup: 'run-id idempotency',
  dirty: 'dirty input',
} as const;

async function request(
  method: string,
  url: string,
  init: { body?: string; headers?: Record<string, string> },
  timeoutMs: number,
): Promise<WireResponse> {
  try {
    const fetchInit: RequestInit = { method, headers: { 'content-type': 'application/json', ...init.headers } };
    if (init.body !== undefined) fetchInit.body = init.body;
    const res = await fetch(url, { ...fetchInit, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let envelope: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(text) as unknown;
      envelope = parsed !== null && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).status === 'string'
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      envelope = null;
    }
    return { ok: res.ok, status: res.status, text, envelope };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      text: '',
      envelope: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Envelope headers sched sends: content-type + run id + optional worker key. */
function wireHeaders(runId: string, apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { 'x-sched-run-id': runId };
  if (apiKey) headers['x-sched-api-key'] = apiKey;
  return headers;
}

export async function checkWorker(opts: CheckWorkerOptions): Promise<{ scenarios: ScenarioResult[]; ok: boolean }> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollDeadlineMs = opts.pollDeadlineMs ?? 30_000;
  const base = opts.url.replace(/\/+$/, '');
  const scenarios: ScenarioResult[] = [];

  // Per-invocation run-id suffix (F3): a conformant worker caches its outcome
  // by run-id — that IS the idempotency contract — so a second check-worker run
  // against the same worker must not collide with the first. Scenario 5 still
  // reuses ONE id within the invocation: that's the dedup case being validated.
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const rid = (n: number): string => `sched-check-${n}-${suffix}`;

  const record = (name: string, pass: boolean, detail: string, skipped = false): void => {
    scenarios.push({ name, pass, skipped, detail });
  };

  // 1. Sync success — a plain ping must answer 200 {status:"succeeded"}.
  {
    const res = await request('POST', `${base}/ping`, { body: JSON.stringify({ task: { name: 'ping', config: {} }, data: {} }), headers: wireHeaders(rid(1), opts.apiKey) }, timeoutMs);
    const pass = res.ok && res.envelope?.status === 'succeeded';
    record(SCENARIO_NAMES.sync, pass, pass ? '200 {status:"succeeded"}' : `expected 200 succeeded, got ${res.status ?? 'error'} ${res.error ?? JSON.stringify(res.envelope ?? res.text)}`);
  }

  // 2. Sync failure — data.fail=true must be reported as {status:"failed"}.
  {
    const res = await request('POST', `${base}/ping`, { body: JSON.stringify({ task: { name: 'ping', config: {} }, data: { fail: true } }), headers: wireHeaders(rid(2), opts.apiKey) }, timeoutMs);
    const pass = res.ok && res.envelope?.status === 'failed' && typeof res.envelope.error === 'string';
    record(SCENARIO_NAMES.syncFail, pass, pass ? '200 {status:"failed", error}' : `expected 200 failed, got ${res.status ?? 'error'} ${res.error ?? JSON.stringify(res.envelope ?? res.text)}`);
  }

  // 3. Async lifecycle — accepted → statusUrl → running (progress grows) → succeeded.
  {
    const dispatch = await request('POST', `${base}/long`, { body: JSON.stringify({ task: { name: 'long', config: {} }, data: {} }), headers: wireHeaders(rid(3), opts.apiKey) }, timeoutMs);
    const statusUrl = dispatch.envelope && typeof dispatch.envelope.statusUrl === 'string' ? (dispatch.envelope.statusUrl as string) : null;
    if (statusUrl === null) {
      record(SCENARIO_NAMES.async, false, `expected 202 accepted + statusUrl, got ${dispatch.status ?? 'error'} ${dispatch.error ?? JSON.stringify(dispatch.envelope ?? dispatch.text)}`);
    } else {
      const deadline = Date.now() + pollDeadlineMs;
      let lastProgress = -1;
      let outcome = 'no terminal state within deadline';
      let pass = false;
      while (Date.now() < deadline) {
        const poll = await request('GET', statusUrl, { headers: wireHeaders(rid(3), opts.apiKey) }, timeoutMs);
        if (!poll.ok || !poll.envelope) {
          outcome = `poll failed: ${poll.status ?? 'error'} ${poll.error ?? poll.text}`;
          break;
        }
        const status = poll.envelope.status;
        if (status === 'running' || status === 'queued') {
          const progress = typeof poll.envelope.progress === 'number' ? poll.envelope.progress : 0;
          if (progress < lastProgress) {
            outcome = 'progress went backwards';
            break;
          }
          lastProgress = progress;
          await new Promise((r) => setTimeout(r, 10));
          continue;
        }
        if (status === 'succeeded') {
          pass = true;
          outcome = 'accepted → running → succeeded';
          break;
        }
        if (status === 'failed') {
          outcome = `poll reported failed: ${String(poll.envelope.error ?? '')}`;
          break;
        }
        outcome = `unexpected poll status '${String(status)}'`;
        break;
      }
      record(SCENARIO_NAMES.async, pass, outcome);
    }
  }

  // 4. Auth — only meaningful when a worker key was given.
  if (opts.apiKey === undefined) {
    record(SCENARIO_NAMES.auth, true, 'skipped (no --api-key)', true);
  } else {
    const without = await request('POST', `${base}/ping`, { body: JSON.stringify({ task: { name: 'ping', config: {} }, data: {} }), headers: wireHeaders(rid(4)) }, timeoutMs);
    const withKey = await request('POST', `${base}/ping`, { body: JSON.stringify({ task: { name: 'ping', config: {} }, data: {} }), headers: wireHeaders(rid(4), opts.apiKey) }, timeoutMs);
    const pass = !without.ok && withKey.ok;
    record(SCENARIO_NAMES.auth, pass, pass ? 'no key → non-2xx, with key → 2xx' : `expected no-key non-2xx + keyed 2xx, got no-key ${without.status ?? 'error'}, keyed ${withKey.status ?? 'error'}`);
  }

  // 5. Run-id idempotency — two dispatches with the same run id must agree.
  {
    const first = await request('POST', `${base}/ping`, { body: JSON.stringify({ task: { name: 'ping', config: {} }, data: {} }), headers: wireHeaders(rid(5), opts.apiKey) }, timeoutMs);
    const second = await request('POST', `${base}/ping`, { body: JSON.stringify({ task: { name: 'ping', config: {} }, data: {} }), headers: wireHeaders(rid(5), opts.apiKey) }, timeoutMs);
    const same = first.envelope !== null && second.envelope !== null && JSON.stringify(first.envelope) === JSON.stringify(second.envelope);
    const pass = first.ok && second.ok && same;
    record(SCENARIO_NAMES.dedup, pass, pass ? 'same run id → identical envelope' : `expected identical responses, got ${JSON.stringify(first.envelope)} vs ${JSON.stringify(second.envelope)}`);
  }

  // 6. Dirty input — garbage must not crash the worker (4xx/500), and the
  //    worker must still serve a follow-up ping.
  {
    const dirty = await request('POST', `${base}/ping`, { body: 'not-json{{{' }, timeoutMs);
    const rejected = dirty.status >= 400 && dirty.status < 600;
    const alive = await request('POST', `${base}/ping`, { body: JSON.stringify({ task: { name: 'ping', config: {} }, data: {} }), headers: wireHeaders(rid(6), opts.apiKey) }, timeoutMs);
    const pass = rejected && alive.ok;
    record(SCENARIO_NAMES.dirty, pass, pass ? `garbage → ${dirty.status}, worker alive` : `expected 4xx/500 + alive worker, got garbage ${dirty.status ?? 'error'}, alive=${alive.ok}`);
  }

  const ok = scenarios.every((s) => s.pass);
  return { scenarios, ok };
}

/** TTY rendering of the verdict. */
export function renderVerdict(base: string, scenarios: ScenarioResult[]): string {
  const lines = [`check-worker ${base}`];
  let passCount = 0;
  for (const s of scenarios) {
    if (s.pass) passCount += 1;
    const badge = s.skipped ? '[SKIP]' : s.pass ? '[PASS]' : '[FAIL]';
    lines.push(`  ${badge} ${s.name} — ${s.detail}`);
  }
  const total = scenarios.length;
  lines.push(`${passCount}/${total} PASS`);
  return lines.join('\n');
}
