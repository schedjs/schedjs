import { describe, expect, it } from 'vitest';
import { createHttpRunner } from '../../src/runners/http.js';
import type { TaskRecord } from '../../src/types.js';

const task = (config: Record<string, unknown>): TaskRecord => ({
  name: 'task-a',
  runner: 'http',
  schedule: { kind: 'cron', cron: '0 9 * * *' },
  tz: 'UTC',
  config,
  label: null,
  description: null,
  nextRunAt: new Date('2026-08-16T09:00:00Z'),
  lastRunAt: null,
  lockedAt: null,
  failCount: 0,
  priority: 0,
  retry: null,
  retryCount: 0,
  lastRunId: null,
  paused: false,
  disabled: false,
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('http runner', () => {
  it('POSTs to the configured url and succeeds on 2xx', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response('ok', { status: 200 });
    };
    const runner = createHttpRunner({ fetch: fetchMock as typeof fetch });
    const startedAt = new Date('2026-08-16T09:00:00Z');

    const outcome = await runner.run(task({ url: 'http://worker:3000/tasks/sync' }), 'run-1', startedAt);

    expect(outcome).toEqual({ status: 'succeeded' });
    expect(captured!.url).toBe('http://worker:3000/tasks/sync');
    expect(captured!.init.method).toBe('POST');
    expect((captured!.init.headers as Record<string, string>)['x-sched-run-id']).toBe('run-1');
  });

  it('sends the configured method, headers and JSON body', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response('ok', { status: 200 });
    };
    const runner = createHttpRunner({ fetch: fetchMock as typeof fetch });

    await runner.run(
      task({
        url: 'http://worker:3000/tasks/sync',
        method: 'PUT',
        headers: { authorization: 'Bearer x' },
        body: { force: true },
      }),
      'run-1',
      new Date('2026-08-16T09:00:00Z'),
    );

    expect(captured!.init.method).toBe('PUT');
    expect((captured!.init.headers as Record<string, string>)['authorization']).toBe('Bearer x');
    expect(JSON.parse(captured!.init.body as string)).toEqual({ force: true });
  });

  it('fails on non-2xx status with the status code', async () => {
    const fetchMock = async () => new Response('boom', { status: 500 });
    const runner = createHttpRunner({ fetch: fetchMock as typeof fetch });

    const outcome = await runner.run(task({ url: 'http://worker:3000/tasks/sync' }), 'run-1', new Date());

    expect(outcome).toEqual({ status: 'failed', error: 'HTTP 500' });
  });

  it('fails when the request throws (network error)', async () => {
    const fetchMock = async () => {
      throw new Error('ECONNREFUSED');
    };
    const runner = createHttpRunner({ fetch: fetchMock as typeof fetch });

    const outcome = await runner.run(task({ url: 'http://worker:3000/tasks/sync' }), 'run-1', new Date());

    expect(outcome).toEqual({ status: 'failed', error: 'ECONNREFUSED' });
  });

  it('aborts after the timeout and reports it as a failure', async () => {
    const fetchMock = async (_url: string | URL | Request, init?: RequestInit) => {
      await new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
      throw new Error('unreachable');
    };
    const runner = createHttpRunner({ fetch: fetchMock as typeof fetch, timeoutMs: 50 });

    const outcome = await runner.run(task({ url: 'http://worker:3000/tasks/slow' }), 'run-1', new Date());

    expect(outcome.status).toBe('failed');
    expect((outcome as { error: string }).error).toBe('aborted');
  });

  it('aborts the request on user cancel (hooks.signal) and reports cancelled', async () => {
    const fetchMock = async (_url: string | URL | Request, init?: RequestInit) => {
      await new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
      throw new Error('unreachable');
    };
    const runner = createHttpRunner({ fetch: fetchMock as typeof fetch });
    const controller = new AbortController();
    const outcomeP = runner.run(task({ url: 'http://worker:3000/tasks/slow' }), 'run-1', new Date(), {
      signal: controller.signal,
    });
    controller.abort(); // POST /runs/:id/cancel → engine.cancelRun → signal
    const outcome = await outcomeP;
    expect(outcome).toEqual({ status: 'cancelled', error: 'cancelled by user' });
  });
});

describe('http runner v2 — protocol envelope', () => {
  it('sends the request envelope { task, data } when envelope is enabled', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response('ok', { status: 200 });
    };
    const runner = createHttpRunner({ fetch: fetchMock as typeof fetch });

    await runner.run(
      task({ url: 'http://worker:3000/tasks/run', envelope: true, data: { dryRun: true }, timeoutMs: 9000 }),
      'run-9',
      new Date('2026-08-16T09:00:00Z'),
    );

    const body = JSON.parse(captured!.init.body as string) as Record<string, unknown>;
    expect(body.task).toEqual({ name: 'task-a', config: expect.objectContaining({ url: 'http://worker:3000/tasks/run' }) });
    expect(body.data).toEqual({ dryRun: true });
    expect((captured!.init.headers as Record<string, string>)['x-sched-run-id']).toBe('run-9');
  });

  it('falls back to config.body as envelope data (raw body is the data source)', async () => {
    let captured: { init: RequestInit } | null = null;
    const fetchMock = async (_url: string | URL | Request, init?: RequestInit) => {
      captured = { init: init ?? {} };
      return new Response('ok', { status: 200 });
    };
    const runner = createHttpRunner({ fetch: fetchMock as typeof fetch });

    await runner.run(task({ url: 'http://w/', envelope: true, body: { fromBody: 1 } }), 'run-1', new Date());

    const body = JSON.parse(captured!.init.body as string) as Record<string, unknown>;
    expect(body.data).toEqual({ fromBody: 1 });
  });

  it('parses a sync succeeded envelope with result/log/progress/artifacts', async () => {
    const runner = createHttpRunner({
      fetch: (async () =>
        jsonResponse(200, {
          status: 'succeeded',
          result: { ok: true, count: 7 },
          progress: 100,
          log: 'all good',
          artifacts: [{ kind: 's3', ref: 's3://b/r.pdf', label: null }],
        })) as typeof fetch,
    });

    const outcome = await runner.run(task({ url: 'http://w/', envelope: true }), 'run-1', new Date());

    expect(outcome).toEqual({
      status: 'succeeded',
      result: { ok: true, count: 7 },
      progress: 100,
      log: 'all good',
      artifacts: [{ kind: 's3', ref: 's3://b/r.pdf', label: null }],
    });
  });

  it('parses a failed envelope (error + log)', async () => {
    const runner = createHttpRunner({
      fetch: (async () => jsonResponse(200, { status: 'failed', error: 'worker died', log: 'trace…' })) as typeof fetch,
    });

    const outcome = await runner.run(task({ url: 'http://w/', envelope: true }), 'run-1', new Date());

    expect(outcome).toEqual({ status: 'failed', error: 'worker died', log: 'trace…' });
  });

  it('parses an accepted envelope (202) into an async outcome', async () => {
    const runner = createHttpRunner({
      fetch: (async () =>
        jsonResponse(202, { status: 'accepted', statusUrl: 'http://worker:3000/status/run-1', pollIntervalMs: 1500 })) as typeof fetch,
    });

    const outcome = await runner.run(task({ url: 'http://w/', envelope: true }), 'run-1', new Date());

    expect(outcome).toEqual({
      status: 'accepted',
      statusUrl: 'http://worker:3000/status/run-1',
      pollIntervalMs: 1500,
    });
  });

  it('defaults pollIntervalMs to 1000 when absent', async () => {
    const runner = createHttpRunner({
      fetch: (async () => jsonResponse(202, { status: 'accepted', statusUrl: 'http://w/status' })) as typeof fetch,
    });

    const outcome = await runner.run(task({ url: 'http://w/', envelope: true }), 'run-1', new Date());

    expect(outcome).toEqual({ status: 'accepted', statusUrl: 'http://w/status', pollIntervalMs: 1000 });
  });

  it('treats an accepted envelope without statusUrl as a failure', async () => {
    const runner = createHttpRunner({
      fetch: (async () => jsonResponse(202, { status: 'accepted' })) as typeof fetch,
    });

    const outcome = await runner.run(task({ url: 'http://w/', envelope: true }), 'run-1', new Date());

    expect(outcome.status).toBe('failed');
    expect((outcome as { error: string }).error).toContain('statusUrl');
  });

  it('keeps simple 2xx-without-envelope behaviour (bare success)', async () => {
    const runner = createHttpRunner({ fetch: (async () => new Response('plain', { status: 200 })) as typeof fetch });
    expect(await runner.run(task({ url: 'http://w/' }), 'run-1', new Date())).toEqual({ status: 'succeeded' });
  });

  it('simple 2xx stores a JSON body as run.result (docs contract: the body is the result)', async () => {
    const runner = createHttpRunner({
      fetch: (async () => jsonResponse(200, { greeting: 'hello from worker' })) as typeof fetch,
    });
    expect(await runner.run(task({ url: 'http://w/' }), 'run-1', new Date())).toEqual({
      status: 'succeeded',
      result: { greeting: 'hello from worker' },
    });
  });

  it('simple 2xx with a JSON envelope-shaped body still goes through the envelope path', async () => {
    const runner = createHttpRunner({
      fetch: (async () => jsonResponse(200, { status: 'succeeded', result: { ok: true } })) as typeof fetch,
    });
    expect(await runner.run(task({ url: 'http://w/' }), 'run-1', new Date())).toEqual({
      status: 'succeeded',
      result: { ok: true },
    });
  });

  it('rejects an intermediate status from a dispatch response as a contract violation', async () => {
    const runner = createHttpRunner({
      fetch: (async () => jsonResponse(200, { status: 'running', progress: 10 })) as typeof fetch,
    });

    const outcome = await runner.run(task({ url: 'http://w/', envelope: true }), 'run-1', new Date());

    expect(outcome.status).toBe('failed');
  });

  it('fails a 2xx non-envelope body in envelope mode — broken worker, never silent success', async () => {
    // The battle-stand repro: worker answers 200 + { runId, verdict, stages } without `status`.
    // In envelope mode this must NOT fall back to simple-mode success.
    const runner = createHttpRunner({
      fetch: (async () => jsonResponse(200, { runId: 'r-1', verdict: 'ok', stages: [] })) as typeof fetch,
    });

    const outcome = await runner.run(task({ url: 'http://w/', envelope: true }), 'run-1', new Date());

    expect(outcome.status).toBe('failed');
    expect((outcome as { error: string }).error).toContain('broken worker');
  });

  it('resolves a relative statusUrl against the task base url', async () => {
    const runner = createHttpRunner({
      fetch: (async () =>
        jsonResponse(202, { status: 'accepted', statusUrl: '/status/run-1', pollIntervalMs: 1500 })) as typeof fetch,
    });

    const outcome = await runner.run(task({ url: 'http://worker:3000/tasks/run', envelope: true }), 'run-1', new Date());

    expect(outcome).toEqual({
      status: 'accepted',
      statusUrl: 'http://worker:3000/status/run-1',
      pollIntervalMs: 1500,
    });
  });

  it('resolves a path-relative statusUrl (no leading slash) against the base url directory', async () => {
    const runner = createHttpRunner({
      fetch: (async () => jsonResponse(202, { status: 'accepted', statusUrl: 'status/run-1' })) as typeof fetch,
    });

    const outcome = await runner.run(task({ url: 'http://worker:3000/tasks/run', envelope: true }), 'run-1', new Date());

    expect((outcome as { statusUrl: string }).statusUrl).toBe('http://worker:3000/tasks/status/run-1');
  });

  it('leaves an absolute statusUrl untouched (backward compatible)', async () => {
    const runner = createHttpRunner({
      fetch: (async () =>
        jsonResponse(202, { status: 'accepted', statusUrl: 'https://other.example/status/r1' })) as typeof fetch,
    });

    const outcome = await runner.run(task({ url: 'http://w/', envelope: true }), 'run-1', new Date());

    expect((outcome as { statusUrl: string }).statusUrl).toBe('https://other.example/status/r1');
  });

  it('resolves a relative cancelUrl against the task base url (like statusUrl)', async () => {
    const runner = createHttpRunner({
      fetch: (async () =>
        jsonResponse(202, {
          status: 'accepted',
          statusUrl: '/status/run-1',
          cancelUrl: '/cancel/run-1',
          pollIntervalMs: 1500,
        })) as typeof fetch,
    });

    const outcome = await runner.run(task({ url: 'http://worker:3000/tasks/run', envelope: true }), 'run-1', new Date());

    expect(outcome).toEqual({
      status: 'accepted',
      statusUrl: 'http://worker:3000/status/run-1',
      cancelUrl: 'http://worker:3000/cancel/run-1',
      pollIntervalMs: 1500,
    });
  });

  it('fails an unresolvable cancelUrl instead of throwing through', async () => {
    const runner = createHttpRunner({
      fetch: (async () =>
        jsonResponse(202, {
          status: 'accepted',
          statusUrl: '/status/run-1',
          cancelUrl: 'http://',
        })) as typeof fetch,
    });

    const outcome = await runner.run(task({ url: 'http://worker:3000/tasks/run', envelope: true }), 'run-1', new Date());

    expect((outcome as { status: string }).status).toBe('failed');
    expect((outcome as { error: string }).error).toContain('cancelUrl');
  });

  it('fails an unresolvable statusUrl instead of throwing through', async () => {
    const runner = createHttpRunner({
      fetch: (async () => jsonResponse(202, { status: 'accepted', statusUrl: 'http://' })) as typeof fetch,
    });

    const outcome = await runner.run(task({ url: 'http://w/', envelope: true }), 'run-1', new Date());

    expect(outcome.status).toBe('failed');
    expect((outcome as { error: string }).error).toContain('statusUrl');
  });

  it('timeoutMs: -1 removes the dispatch request timeout (only engine/manual abort stops the run)', async () => {
    let captured: RequestInit | null = null;
    const fetchMock = async (_url: string | URL | Request, init?: RequestInit) => {
      captured = init ?? {};
      return jsonResponse(200, { status: 'succeeded' });
    };
    const runner = createHttpRunner({ fetch: fetchMock as typeof fetch });

    const outcome = await runner.run({ ...task({ url: 'http://w/', envelope: true }), timeoutMs: -1 }, 'run-1', new Date());

    expect(captured!.signal).toBeUndefined();
    expect(outcome.status).toBe('succeeded');
  });

  it('caps the dispatch request with task.timeoutMs (positive) instead of the 30s default', async () => {
    const fetchMock = async (_url: string | URL | Request, init?: RequestInit) => {
      await new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
      throw new Error('unreachable');
    };
    const runner = createHttpRunner({ fetch: fetchMock as typeof fetch });

    const started = Date.now();
    const outcome = await runner.run({ ...task({ url: 'http://w/', envelope: true }), timeoutMs: 40 }, 'run-1', new Date());

    expect(Date.now() - started).toBeLessThan(1000); // aborted at ~40ms, not 30s
    expect(outcome.status).toBe('failed');
  });

  it('sends x-sched-api-key by default and honours a custom auth header', async () => {
    const captured: Array<Record<string, string>> = [];
    const fetchMock = async (_url: string | URL | Request, init?: RequestInit) => {
      captured.push((init?.headers ?? {}) as Record<string, string>);
      return new Response('ok', { status: 200 });
    };
    const runner = createHttpRunner({ fetch: fetchMock as typeof fetch });

    await runner.run(task({ url: 'http://w/', auth: { apiKey: 'secret-1' } }), 'run-1', new Date());
    await runner.run(task({ url: 'http://w/', auth: { apiKey: 'secret-2', header: 'x-worker-token' } }), 'run-2', new Date());

    expect(captured[0]!['x-sched-api-key']).toBe('secret-1');
    expect(captured[1]!['x-worker-token']).toBe('secret-2');
    expect(captured[1]!['x-sched-api-key']).toBeUndefined();
  });

  describe('poll', () => {
    it('GETs the statusUrl and maps an intermediate envelope to a PollResult', async () => {
      let polled: { url: string; init: RequestInit } | null = null;
      const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
        polled = { url: String(url), init: init ?? {} };
        return jsonResponse(200, { status: 'running', progress: 50, log: 'halfway' });
      };
      const runner = createHttpRunner({ fetch: fetchMock as typeof fetch });

      const result = await runner.poll!('run-1', 'http://worker:3000/status/run-1');

      expect(polled!.url).toBe('http://worker:3000/status/run-1');
      expect(polled!.init.method).toBe('GET');
      expect((polled!.init.headers as Record<string, string>)['x-sched-run-id']).toBe('run-1');
      expect(result).toEqual({ status: 'running', progress: 50, log: 'halfway' });
    });

    it('maps a terminal poll envelope to a terminal PollResult', async () => {
      const runner = createHttpRunner({
        fetch: (async () =>
          jsonResponse(200, { status: 'succeeded', result: { done: true }, log: 'finished' })) as typeof fetch,
      });

      const result = await runner.poll!('run-1', 'http://w/status');

      expect(result).toEqual({ status: 'succeeded', result: { done: true }, log: 'finished' });
    });

    it('throws when the poll endpoint is unreachable (non-2xx)', async () => {
      const runner = createHttpRunner({ fetch: (async () => new Response('no', { status: 503 })) as typeof fetch });

      await expect(runner.poll!('run-1', 'http://w/status')).rejects.toThrow(/503/);
    });

    it('throws when the poll body is not a JSON envelope', async () => {
      const runner = createHttpRunner({ fetch: (async () => new Response('html', { status: 200 })) as typeof fetch });

      await expect(runner.poll!('run-1', 'http://w/status')).rejects.toThrow();
    });

    it('sends x-sched-api-key on poll when the task config carries auth (v2)', async () => {
      let captured: { url: string; init: RequestInit } | null = null;
      const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(url), init: init ?? {} };
        return jsonResponse(200, { status: 'succeeded', result: { done: true } });
      };
      const runner = createHttpRunner({ fetch: fetchMock as typeof fetch });

      await runner.poll!('run-1', 'http://worker:3000/status/run-1', task({ url: 'http://w/', auth: { apiKey: 'secret-1' } }));

      expect((captured!.init.headers as Record<string, string>)['x-sched-api-key']).toBe('secret-1');
    });

    it('retries a transient poll network error and succeeds on the retry', async () => {
      let n = 0;
      const fetchMock = async () => {
        n++;
        if (n === 1) throw new Error('fetch failed');
        return jsonResponse(200, { status: 'succeeded', result: { done: true } });
      };
      const runner = createHttpRunner({ fetch: fetchMock as typeof fetch, pollRetryDelayMs: 1 });

      const result = await runner.poll!('run-1', 'http://w/status');

      expect(result).toEqual({ status: 'succeeded', result: { done: true } });
      expect(n).toBe(2);
    });

    it('labels an exhausted poll network error as a poll failure (not bare fetch failed)', async () => {
      const runner = createHttpRunner({
        fetch: (async () => {
          throw new Error('fetch failed');
        }) as typeof fetch,
        pollRetryDelayMs: 1,
      });

      await expect(runner.poll!('run-1', 'http://w/status')).rejects.toThrow(/http runner: poll failed: fetch failed/);
    });

    it('retries a transient 5xx poll and fails with the poll label after exhaustion', async () => {
      let n = 0;
      const fetchMock = async () => {
        n++;
        return new Response('boom', { status: 503 });
      };
      const runner = createHttpRunner({ fetch: fetchMock as typeof fetch, pollRetryDelayMs: 1 });

      await expect(runner.poll!('run-1', 'http://w/status')).rejects.toThrow(/http runner: poll failed: poll HTTP 503/);
      expect(n).toBe(3); // default pollRetries: 2 → 3 attempts total
    });

    it('does not retry a permanent 4xx poll error', async () => {
      let n = 0;
      const fetchMock = async () => {
        n++;
        return new Response('no', { status: 404 });
      };
      const runner = createHttpRunner({ fetch: fetchMock as typeof fetch, pollRetryDelayMs: 1 });

      await expect(runner.poll!('run-1', 'http://w/status')).rejects.toThrow(/http runner: poll failed: poll HTTP 404/);
      expect(n).toBe(1);
    });
  });
});

describe('http runner — headers & envelope hygiene (peer-review regression)', () => {
  async function capture(config: Record<string, unknown>): Promise<RequestInit> {
    let captured: RequestInit | null = null;
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      captured = init ?? {};
      return new Response('ok', { status: 200 });
    };
    const runner = createHttpRunner({ fetch: fetchMock as typeof fetch });
    await runner.run(task(config), 'run-1', new Date('2026-08-16T09:00:00Z'));
    return captured!;
  }

  it('sends content-type: application/json by default (runner protocol)', async () => {
    const init = await capture({ url: 'http://worker:3000/tasks/sync' });
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('lets a user header override content-type but never x-sched-run-id', async () => {
    const init = await capture({
      url: 'http://worker:3000/tasks/sync',
      headers: { 'content-type': 'text/csv', 'x-sched-run-id': 'hijacked' },
    });
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('text/csv');
    expect(headers['x-sched-run-id']).toBe('run-1'); // idempotency is not user-overridable
  });

  it('does not echo worker auth credentials into the envelope body', async () => {
    const init = await capture({
      url: 'http://worker:3000/tasks/sync',
      envelope: true,
      auth: { apiKey: 'super-secret-key' },
      data: { page: 2 },
    });
    const body = JSON.parse(String(init.body)) as { task: { config: Record<string, unknown> } };
    expect(body.task.config.auth).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('super-secret-key');
    // but the key still goes in the header
    expect((init.headers as Record<string, string>)['x-sched-api-key']).toBe('super-secret-key');
  });
});

describe('http runner — async cancel channel (cancelUrl)', () => {
  it('cancel() without a cancelUrl is a no-op — no request is made', async () => {
    let requests = 0;
    const fetchMock = (async () => {
      requests++;
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    const runner = createHttpRunner({ fetch: fetchMock });

    await runner.cancel!('run-1', 'http://worker:3000/status/r1', task({ url: 'http://worker:3000' }), null);

    expect(requests).toBe(0); // legacy stop-polling semantics — nothing to call
  });

  it('cancel() POSTs {runId} to the cancelUrl with run-id + auth headers', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    const runner = createHttpRunner({ fetch: fetchMock });

    await runner.cancel!(
      'run-1',
      'http://worker:3000/status/r1',
      task({ url: 'http://worker:3000', auth: { apiKey: 'k' } }),
      'http://worker:3000/cancel/r1',
    );

    expect(captured!.url).toBe('http://worker:3000/cancel/r1');
    expect(captured!.init.method).toBe('POST');
    expect(JSON.parse(String(captured!.init.body))).toEqual({ runId: 'run-1' });
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers['x-sched-run-id']).toBe('run-1');
    expect(headers['x-sched-api-key']).toBe('k');
  });

  it('cancel() returns the response status for the engine cancel-ack event', async () => {
    const runner = createHttpRunner({
      fetch: (async () => new Response('ok', { status: 202 })) as typeof fetch,
    });

    const status = await runner.cancel!(
      'run-1',
      'http://worker:3000/status/r1',
      task({ url: 'http://worker:3000' }),
      'http://worker:3000/cancel/r1',
    );

    expect(status).toBe(202);
  });

  it('cancel() throws on a non-ok response — the engine records the failed signal', async () => {
    const runner = createHttpRunner({
      fetch: (async () => new Response('gone', { status: 404 })) as typeof fetch,
    });

    await expect(
      runner.cancel!('run-1', 'http://worker:3000/status/r1', task({ url: 'http://worker:3000' }), 'http://worker:3000/cancel/r1'),
    ).rejects.toThrow(/cancel HTTP 404/);
  });
});
