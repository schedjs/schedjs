import type { PollResult, RunOutcome, Runner, RunnerRunHooks } from '../engine.js';
import type { ArtifactRef, TaskRecord } from '../types.js';

/** RunOutcome minus accepted/cancelled — what the envelope parser produces. */
type SyncOutcome = Exclude<RunOutcome, { status: 'accepted' } | { status: 'cancelled' }>;

/** Runner-specific config carried in `TaskRecord.config`. */
export interface HttpRunnerConfig {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /**
   * Protocol mode (v2 envelope): body becomes `{ task, data }` and the worker's
   * JSON response is parsed per the runner protocol (sync / accepted / poll).
   * Off (default) → simple: raw `body`, 2xx = succeeded.
   */
  envelope?: boolean;
  /** Run parameters for the envelope's `data` field. Falls back to `body`. */
  data?: unknown;
  /** Outbound auth. Sent on dispatch AND poll (see runner-auth track). */
  auth?: { apiKey: string; header?: string };
  /** Overrides the runner-level default. */
  timeoutMs?: number;
}

export interface HttpRunnerOptions {
  /** Injectable fetch for tests. Default: global fetch. */
  fetch?: typeof fetch;
  /** Default request timeout. Default: 30s. */
  timeoutMs?: number;
  /**
   * Transient poll retries before the run is given up (network blips, worker
   * 5xx/408/429). Default: 2 retries → 3 attempts total. Permanent poll errors
   * (4xx, non-envelope, unexpected status) are never retried.
   */
  pollRetries?: number;
  /** Delay between transient poll retries. Default: 500ms. */
  pollRetryDelayMs?: number;
}

function asRecord(value: unknown): Record<string, string> {
  return value !== null && typeof value === 'object' ? (value as Record<string, string>) : {};
}

/** The worker-side envelope as defined by the runner protocol. */
interface Envelope {
  status?: string;
  result?: unknown;
  error?: string | null;
  progress?: number | null;
  log?: string | null;
  artifacts?: ArtifactRef[] | null;
  statusUrl?: string;
  /** Optional worker cancel channel: sched POSTs {runId} here on user cancel (async runs). */
  cancelUrl?: string;
  pollIntervalMs?: number;
}

async function parseEnvelope(response: Response): Promise<Envelope | null> {
  try {
    return parseEnvelopeText(await response.text());
  } catch {
    return null;
  }
}

/** Parse an envelope from a JSON body — null when the body is not an envelope. */
function parseEnvelopeText(text: string): Envelope | null {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    return body && typeof body === 'object' && typeof body.status === 'string' ? (body as Envelope) : null;
  } catch {
    return null;
  }
}

/** Simple mode: a 2xx JSON body is the run result. Non-JSON → null (no result). */
function simpleResult(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Envelope fields that map 1:1 onto sync outcomes — only present ones are copied. */
function pickEnvelope(env: Envelope): {
  result?: unknown;
  progress?: number | null;
  log?: string | null;
  artifacts?: ArtifactRef[] | null;
} {
  const out: { result?: unknown; progress?: number | null; log?: string | null; artifacts?: ArtifactRef[] | null } = {};
  if (env.result !== undefined) out.result = env.result;
  if (env.progress !== undefined) out.progress = env.progress;
  if (env.log !== undefined) out.log = env.log;
  if (env.artifacts !== undefined) out.artifacts = env.artifacts;
  return out;
}

function terminalFromEnvelope(env: Envelope): SyncOutcome | null {
  if (env.status === 'succeeded') {
    return { status: 'succeeded', ...pickEnvelope(env) };
  }
  if (env.status === 'failed') {
    return { status: 'failed', error: env.error ?? 'worker reported failure', ...pickEnvelope(env) };
  }
  return null;
}

/**
 * HTTP runner v2: fires a request per the task's `config` (HttpRunnerConfig).
 *
 * Simple mode (default): raw `config.body`, 2xx → succeeded, run id in the
 * `x-sched-run-id` header. Envelope mode (`config.envelope`): request body is
 * `{ task: { name, config }, data }`, and the response is parsed per the runner
 * protocol — sync envelope (succeeded/failed with result/log/progress/artifacts)
 * or `202 accepted` with a `statusUrl` the engine polls via `poll()`.
 *
 * Outbound auth: `config.auth.apiKey` is sent as `x-sched-api-key` by default
 * (customizable via `config.auth.header`) on both dispatch and poll requests.
 * Idempotency lives on the worker side (it dedupes by `x-sched-run-id`); the
 * runner's job is to always carry the run id.
 */
export function createHttpRunner(options: HttpRunnerOptions = {}): Runner {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const defaultTimeoutMs = options.timeoutMs ?? 30_000;

  function headersFor(cfg: Partial<HttpRunnerConfig>, runId: string): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json', // runner protocol — workers may validate it
      ...asRecord(cfg.headers),
    };
    if (cfg.auth?.apiKey) {
      headers[cfg.auth.header ?? 'x-sched-api-key'] = cfg.auth.apiKey;
    }
    // last, never overridable: the worker dedupes by run id — idempotency is the contract
    headers['x-sched-run-id'] = runId;
    return headers;
  }

  /**
   * Dispatch transport timeout — the run-deadline contract (task.timeoutMs)
   * governs the request: `>0` caps it at the deadline, `-1` removes it (only
   * the engine/manual abort stops the run). An explicit `config.timeoutMs`
   * transport override always wins; a `null` task timeoutMs (legacy DB row
   * not yet re-synced) keeps the 30s default — tasks.json absent parses to
   * `-1` since 0.46. Poll requests use their own short transport guard (see
   * `poll`).
   */
  function dispatchTimeoutMs(task: TaskRecord, cfg: Partial<HttpRunnerConfig>): number | undefined {
    if (cfg.timeoutMs !== undefined) return cfg.timeoutMs;
    const t = task.timeoutMs ?? null;
    if (t === -1) return undefined;
    if (t !== null && t > 0) return t;
    return defaultTimeoutMs;
  }

  async function request(
    url: string,
    cfg: Partial<HttpRunnerConfig>,
    runId: string,
    init: RequestInit,
    userSignal?: AbortSignal,
    requestTimeoutMs?: number,
  ): Promise<Response> {
    // Timeout OR user-cancel abort the fetch — the catch below tells them apart
    // (userSignal.aborted → AbortError → cancelled; otherwise failed).
    // `requestTimeoutMs === undefined` = no transport timeout (task.timeoutMs:
    // -1 — only the engine/manual abort stops the run).
    const timeoutSignal = requestTimeoutMs === undefined ? undefined : AbortSignal.timeout(requestTimeoutMs);
    const signal = userSignal ? (timeoutSignal ? AbortSignal.any([userSignal, timeoutSignal]) : userSignal) : timeoutSignal;
    const fetchInit: RequestInit = { ...init, headers: headersFor(cfg, runId) };
    if (signal !== undefined) fetchInit.signal = signal;
    try {
      return await fetchImpl(url, fetchInit);
    } catch (err) {
      if (userSignal?.aborted) {
        // user-cancel (run cancellation) → AbortError for the engine → cancelled
        const e = new Error('cancelled by user');
        e.name = 'AbortError';
        throw e;
      }
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  }

  return {
    async run(task: TaskRecord, runId: string, _at?: Date, hooks?: RunnerRunHooks): Promise<RunOutcome> {
      const cfg = task.config as Partial<HttpRunnerConfig>;
      if (!cfg.url) return { status: 'failed', error: 'http runner: missing config.url' };

      const init: RequestInit = { method: cfg.method ?? 'POST' };
      if (cfg.envelope) {
        // worker credentials are sched→worker secrets: never echo `auth` back in the body
        const { auth: _auth, ...config } = task.config as Partial<HttpRunnerConfig>;
        init.body = JSON.stringify({
          task: { name: task.name, config },
          data: cfg.data ?? cfg.body ?? null,
        });
      } else if (cfg.body !== undefined) {
        init.body = JSON.stringify(cfg.body);
      }

      let response: Response;
      try {
        response = await request(cfg.url, cfg, runId, init, hooks?.signal, dispatchTimeoutMs(task, cfg));
      } catch (err) {
        // user-cancel (AbortError) → cancelled; timeout/network → failed
        if (err instanceof Error && err.name === 'AbortError') {
          return { status: 'cancelled', error: err.message };
        }
        return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
      }

      if (!response.ok) return { status: 'failed', error: `HTTP ${response.status}` };

      // Read the body exactly once, then decide: envelope (v2 protocol) or simple.
      const text = await response.text();
      const env = parseEnvelopeText(text);
      if (env !== null) {
        if (env.status === 'accepted') {
          if (!env.statusUrl) {
            return { status: 'failed', error: 'http runner: accepted envelope missing statusUrl' };
          }
          let statusUrl: string;
          try {
            // relative statusUrl (origin- or path-relative) resolves against the
            // task's base url — a worker must not need to know its external address
            statusUrl = new URL(env.statusUrl, cfg.url).toString();
          } catch {
            return { status: 'failed', error: `http runner: invalid statusUrl '${env.statusUrl}'` };
          }
          // cancelUrl is optional — workers that advertise it get a real cancel
          // channel (sched POSTs {runId} on cancel); the rest keep legacy
          // stop-polling semantics. Resolved like statusUrl.
          let cancelUrl: string | undefined;
          if (env.cancelUrl !== undefined) {
            try {
              cancelUrl = new URL(env.cancelUrl, cfg.url).toString();
            } catch {
              return { status: 'failed', error: `http runner: invalid cancelUrl '${env.cancelUrl}'` };
            }
          }
          return {
            status: 'accepted',
            statusUrl,
            ...(cancelUrl !== undefined ? { cancelUrl } : {}),
            pollIntervalMs: env.pollIntervalMs ?? 1_000,
          };
        }
        const terminal = terminalFromEnvelope(env);
        if (terminal) return terminal;
        return {
          status: 'failed',
          error: `http runner: unexpected envelope status '${env.status}' on dispatch (expected succeeded|failed|accepted)`,
        };
      }
      // envelope mode opted in, but a 2xx without a valid envelope is a broken
      // worker — the same doctrine as the stdio runners (never silent success)
      if (cfg.envelope) {
        return {
          status: 'failed',
          error: 'http runner: envelope mode but non-envelope 2xx body — broken worker',
        };
      }
      // simple: 2xx without an envelope — the JSON body is what sched stores in run.result
      const result = simpleResult(text);
      return result === null ? { status: 'succeeded' } : { status: 'succeeded', result };
    },

    async poll(runId: string, statusUrl: string, task?: TaskRecord): Promise<PollResult> {
      // Task config carries per-task auth — the engine passes the originating
      // task so the poll request is authenticated like the dispatch one.
      const cfg = (task?.config ?? {}) as Partial<HttpRunnerConfig>;
      // Transient poll failures (network blips, worker 5xx/408/429) are retried
      // a couple of times before the run is given up — a single lost poll must
      // not kill a live async pipeline (battle-stand incident 2026-08-20).
      // Permanent errors (4xx, non-envelope, unexpected status) fail immediately,
      // and every poll-originated failure carries the `poll failed` label so the
      // operator can tell it apart from a worker-reported terminal failure.
      const maxAttempts = (options.pollRetries ?? 2) + 1;
      const retryDelayMs = options.pollRetryDelayMs ?? 500;
      const transientNetwork = (err: unknown): boolean => {
        if (!(err instanceof Error)) return false;
        return (
          err.name === 'TypeError' ||
          /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(err.message)
        );
      };
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

      for (let attempt = 1; ; attempt++) {
        const last = attempt >= maxAttempts;
        try {
          const response = await request(
            statusUrl,
            cfg,
            runId,
            { method: 'GET' },
            undefined,
            cfg.timeoutMs ?? defaultTimeoutMs,
          );
          if (!response.ok) {
            const transient = response.status === 408 || response.status === 429 || response.status >= 500;
            if (transient && !last) {
              await sleep(retryDelayMs);
              continue;
            }
            throw new Error(`poll HTTP ${response.status}`);
          }

          const env = await parseEnvelope(response);
          if (env === null) throw new Error('poll returned a non-envelope body');

          if (env.status === 'queued' || env.status === 'running') {
            return { status: env.status, ...pickEnvelope(env) };
          }
          const terminal = terminalFromEnvelope(env);
          if (terminal) return terminal;
          throw new Error(`poll returned unexpected status '${env.status}'`);
        } catch (err) {
          if (transientNetwork(err) && !last) {
            await sleep(retryDelayMs);
            continue;
          }
          throw new Error(`http runner: poll failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },

    /**
     * Async cancel channel: POST {runId} to the worker's advertised cancelUrl
     * (same auth + run-id headers as dispatch/poll). Best-effort single shot —
     * a failure throws so the engine records «cancel signal failed» on the run;
     * no cancelUrl (legacy worker) → no-op, the engine falls back to
     * stop-polling semantics (the worker finishes on its own — documented).
     * Returns the response status for the engine's cancel-ack event.
     */
    async cancel(runId: string, _statusUrl: string, task?: TaskRecord, cancelUrl?: string | null): Promise<number | void> {
      if (!cancelUrl) return;
      const cfg = (task?.config ?? {}) as Partial<HttpRunnerConfig>;
      const response = await request(
        cancelUrl,
        cfg,
        runId,
        { method: 'POST', body: JSON.stringify({ runId }) },
        undefined,
        cfg.timeoutMs ?? defaultTimeoutMs,
      );
      if (!response.ok) {
        throw new Error(`http runner: cancel HTTP ${response.status}`);
      }
      return response.status;
    },
  };
}
