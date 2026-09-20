import { createHmac } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { createAlerts, type AlertsConfig } from '../src/alerts.js';
import type { EngineEvent } from '../src/engine.js';
import type { RunRecord } from '../src/types.js';

function makeRun(partial: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r1',
    taskName: 'task-a',
    runner: 'http',
    status: 'failed',
    data: null,
    result: null,
    error: 'boom',
    progress: null,
    log: null,
    artifacts: null,
    workerRef: null,
    startedAt: new Date('2026-08-16T12:00:00Z'),
    finishedAt: new Date('2026-08-16T12:00:01Z'),
    attempt: 3,
    trigger: 'schedule',
    triggeredBy: null,
    scheduleId: null,
    temporary: false,
    retryOf: null,
    ...partial,
  };
}

function makeMissed(): EngineEvent {
  return {
    type: 'missed-slot',
    taskName: 'task-a',
    scheduleId: 'sched-1',
    runner: 'http',
    scheduledAt: new Date('2026-08-16T03:00:00Z'),
    delayMs: 9 * 3600 * 1000,
  };
}

/** fetch mock returning a fixed status; `deps` inject a noop sleep so retry backoff never stalls the suite. */
function makeAlerts(
  config: AlertsConfig,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
) {
  const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(fetchImpl);
  const alerts = createAlerts(config, {
    fetch: fetchMock as unknown as typeof fetch,
    sleep: async () => {},
  });
  return { alerts, fetchMock };
}

function bodyOf(call: [input: string, init?: RequestInit | undefined]): Record<string, unknown> {
  return JSON.parse(call[1]?.body as string) as Record<string, unknown>;
}

const ok = () => new Response('ok', { status: 200 });

describe('alerts — webhook channel', () => {
  it('POSTs a JSON payload with run context to the configured url', async () => {
    const { alerts, fetchMock } = makeAlerts(
      { webhook: { url: 'https://hooks.example.com/ops' } },
      async () => ok(),
    );

    await alerts.handleFinal(makeRun());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://hooks.example.com/ops');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    const body = bodyOf(fetchMock.mock.calls[0]!);
    expect(body.version).toBe(1);
    expect(body.event).toBe('run.failed');
    expect(body.task).toEqual({ name: 'task-a', runner: 'http' });
    expect((body.run as Record<string, unknown>).status).toBe('failed');
    expect((body.run as Record<string, unknown>).attempt).toBe(3);
    expect((body.run as Record<string, unknown>).error).toBe('boom');
    expect((body.run as Record<string, unknown>).startedAt).toBe('2026-08-16T12:00:00.000Z');
  });

  it('signs the exact body with HMAC-SHA256 when secret is set (X-Sched-Signature-256)', async () => {
    const secret = 'whsec_test';
    const { alerts, fetchMock } = makeAlerts(
      { webhook: { url: 'https://hooks.example.com/ops', secret } },
      async () => ok(),
    );

    await alerts.handleFinal(makeRun());

    const [, init] = fetchMock.mock.calls[0]!;
    const body = init?.body as string;
    const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    expect((init?.headers as Record<string, string>)['X-Sched-Signature-256']).toBe(expected);
  });

  it('merges custom headers into the request', async () => {
    const { alerts, fetchMock } = makeAlerts(
      { webhook: { url: 'https://hooks.example.com/ops', headers: { 'X-Ops-Token': 'tok123' } } },
      async () => ok(),
    );

    await alerts.handleFinal(makeRun());

    expect((fetchMock.mock.calls[0]![1]?.headers as Record<string, string>)['X-Ops-Token']).toBe('tok123');
  });

  it('does not fire for statuses not in `on`', async () => {
    const { alerts, fetchMock } = makeAlerts(
      { on: ['failed'], webhook: { url: 'https://hooks.example.com/ops' } },
      async () => ok(),
    );

    await alerts.handleFinal(makeRun({ status: 'succeeded' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps each terminal status to a run.<status> event', async () => {
    const { alerts, fetchMock } = makeAlerts(
      { on: ['failed', 'succeeded', 'cancelled'], webhook: { url: 'https://hooks.example.com/ops' } },
      async () => ok(),
    );

    await alerts.handleFinal(makeRun({ status: 'succeeded', error: null }));
    await alerts.handleFinal(makeRun({ status: 'cancelled', error: 'user' }));

    expect(bodyOf(fetchMock.mock.calls[0]!).event).toBe('run.succeeded');
    expect(bodyOf(fetchMock.mock.calls[1]!).event).toBe('run.cancelled');
  });

  it('retries 5xx responses (3 attempts total, same body re-sent)', async () => {
    let n = 0;
    const { alerts, fetchMock } = makeAlerts(
      { webhook: { url: 'https://hooks.example.com/ops' } },
      async () => (++n < 3 ? new Response('boom', { status: 503 }) : ok()),
    );

    await alerts.handleFinal(makeRun());

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [c0, c1] = [bodyOf(fetchMock.mock.calls[0]!), bodyOf(fetchMock.mock.calls[1]!)];
    expect(c1).toEqual(c0); // retry re-sends the identical payload
  });

  it('retries network errors (3 attempts)', async () => {
    let n = 0;
    const { alerts, fetchMock } = makeAlerts(
      { webhook: { url: 'https://hooks.example.com/ops' } },
      async () => {
        if (++n < 3) throw new Error('ECONNRESET');
        return ok();
      },
    );

    await alerts.handleFinal(makeRun());

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry 4xx responses (config error — retrying is pointless)', async () => {
    const { alerts, fetchMock } = makeAlerts(
      { webhook: { url: 'https://hooks.example.com/ops' } },
      async () => new Response('bad', { status: 400 }),
    );

    await alerts.handleFinal(makeRun());

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never throws — a failing channel cannot fail the run flow', async () => {
    const { alerts } = makeAlerts(
      { webhook: { url: 'https://hooks.example.com/ops' } },
      async () => {
        throw new Error('network down');
      },
    );

    await expect(alerts.handleFinal(makeRun())).resolves.toBeUndefined();
  });
});

describe('alerts — missed-slot', () => {
  it('fires a webhook for missed-slot engine events', async () => {
    const { alerts, fetchMock } = makeAlerts(
      { webhook: { url: 'https://hooks.example.com/ops' } },
      async () => ok(),
    );

    await alerts.handleEvent(makeMissed());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = bodyOf(fetchMock.mock.calls[0]!);
    expect(body.event).toBe('missed-slot');
    expect(body.task).toEqual({ name: 'task-a', runner: 'http' });
    const sched = body.schedule as Record<string, unknown>;
    expect(sched.id).toBe('sched-1');
    expect(sched.scheduledAt).toBe('2026-08-16T03:00:00.000Z');
    expect(sched.delayMs).toBe(9 * 3600 * 1000);
  });

  it('ignores non-missed engine events', async () => {
    const { alerts, fetchMock } = makeAlerts(
      { webhook: { url: 'https://hooks.example.com/ops' } },
      async () => ok(),
    );

    await alerts.handleEvent({ type: 'claim', taskName: 'task-a', runId: 'r1', attempt: 1 });
    await alerts.handleEvent({ type: 'run-failed', taskName: 'task-a', runId: 'r1', attempt: 1, error: 'x' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is silenced by onMissed: false', async () => {
    const { alerts, fetchMock } = makeAlerts(
      { onMissed: false, webhook: { url: 'https://hooks.example.com/ops' } },
      async () => ok(),
    );

    await alerts.handleEvent(makeMissed());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('alerts — per-task routing', () => {
  const webhook = { url: 'https://hooks.example.com/ops' };

  it('resolves per-task `on`: root default applies unless the task overrides', async () => {
    const { alerts, fetchMock } = makeAlerts(
      {
        on: ['failed'],
        webhook,
        tasks: {
          'task-b': { on: ['succeeded'] },
          'task-c': { on: [] },
        },
      },
      async () => ok(),
    );

    // task-a: no override → root default (failed)
    await alerts.handleFinal(makeRun({ taskName: 'task-a' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetchMock.mock.calls[0]!).task).toEqual({ name: 'task-a', runner: 'http' });

    // task-b: override on:['succeeded'] → failed does NOT fire, succeeded does
    await alerts.handleFinal(makeRun({ taskName: 'task-b' }));
    expect(fetchMock).toHaveBeenCalledTimes(1); // still 1 — task-b failed silenced
    await alerts.handleFinal(makeRun({ taskName: 'task-b', status: 'succeeded', error: null }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock.mock.calls[1]!).task).toEqual({ name: 'task-b', runner: 'http' });
  });

  it('on: [] silences a task regardless of the root default (arrays REPLACE, not concat)', async () => {
    const { alerts, fetchMock } = makeAlerts(
      { on: ['failed', 'succeeded'], webhook, tasks: { 'task-c': { on: [] } } },
      async () => ok(),
    );

    await alerts.handleFinal(makeRun({ taskName: 'task-c' }));
    await alerts.handleFinal(makeRun({ taskName: 'task-c', status: 'succeeded', error: null }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves per-task onMissed: a task can opt out of missed-slot alerts', async () => {
    const { alerts, fetchMock } = makeAlerts(
      { webhook, tasks: { 'task-b': { onMissed: false } } },
      async () => ok(),
    );
    const missedFor = (taskName: string): EngineEvent => ({
      type: 'missed-slot',
      taskName,
      scheduleId: 'sched-1',
      runner: 'http',
      scheduledAt: new Date('2026-08-16T03:00:00Z'),
      delayMs: 9 * 3600 * 1000,
    });

    await alerts.handleEvent(missedFor('task-b'));
    expect(fetchMock).not.toHaveBeenCalled();

    await alerts.handleEvent(missedFor('task-a'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetchMock.mock.calls[0]!).task).toEqual({ name: 'task-a', runner: 'http' });
  });

  it('routes a task with its own webhook to THAT webhook (multi-channel escape hatch)', async () => {
    const { alerts, fetchMock } = makeAlerts(
      {
        webhook,
        tasks: {
          'task-b': { webhook: { url: 'https://hooks.example.com/pagerduty' } },
        },
      },
      async () => ok(),
    );

    await alerts.handleFinal(makeRun({ taskName: 'task-a' }));
    await alerts.handleFinal(makeRun({ taskName: 'task-b' }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://hooks.example.com/ops');
    expect(fetchMock.mock.calls[1]![0]).toBe('https://hooks.example.com/pagerduty');
  });

  it('a task with its own webhook alerts even when there is no root webhook', async () => {
    const { alerts, fetchMock } = makeAlerts(
      { tasks: { 'task-b': { webhook: { url: 'https://hooks.example.com/pagerduty' } } } },
      async () => ok(),
    );

    await alerts.handleFinal(makeRun({ taskName: 'task-b' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://hooks.example.com/pagerduty');

    // task-a: no root channel, no override → nothing fires
    await alerts.handleFinal(makeRun({ taskName: 'task-a' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves per-task webhook with the root `on` default', async () => {
    const { alerts, fetchMock } = makeAlerts(
      {
        on: ['failed'],
        webhook,
        tasks: { 'task-b': { webhook: { url: 'https://hooks.example.com/pagerduty' }, onMissed: false } },
      },
      async () => ok(),
    );

    await alerts.handleFinal(makeRun({ taskName: 'task-b' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://hooks.example.com/pagerduty');
    expect(bodyOf(fetchMock.mock.calls[0]!).event).toBe('run.failed');
  });

  describe('sync-failure detection (prod lesson 2026-08-24: a dead mongo pool meant silent non-scheduling)', () => {
    const syncFailed = (consecutiveFailures: number) =>
      ({ type: 'sync-failed', error: 'connection 6 to 172.20.0.5:27017 closed', consecutiveFailures }) as EngineEvent;

    it('POSTs sync.failed to the root webhook on the first failure of a streak', async () => {
      const { alerts, fetchMock } = makeAlerts({ webhook }, async () => ok());

      await alerts.handleEvent(syncFailed(1));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const payload = bodyOf(fetchMock.mock.calls[0]!);
      expect(payload.event).toBe('sync.failed');
      expect(payload.error).toContain('connection 6');
      expect(payload.consecutiveFailures).toBe(1);
    });

    it('dedupes: a streak continuing past the first failure stays silent (no 60s spam on a down mongo)', async () => {
      const { alerts, fetchMock } = makeAlerts({ webhook }, async () => ok());

      await alerts.handleEvent(syncFailed(1));
      await alerts.handleEvent(syncFailed(2));
      await alerts.handleEvent(syncFailed(7));

      expect(fetchMock).toHaveBeenCalledTimes(1); // only the first
    });

    it('honors onSyncFailed: false (silence sync alerts, keep run/missed alerts)', async () => {
      const { alerts, fetchMock } = makeAlerts({ webhook, onSyncFailed: false }, async () => ok());

      await alerts.handleEvent(syncFailed(1));
      await alerts.handleEvent({ type: 'missed-slot', taskName: 'task-a', scheduleId: 'sched-1', runner: 'http', scheduledAt: new Date(), delayMs: 5000 });

      expect(fetchMock).toHaveBeenCalledTimes(1); // only the missed-slot fired
      expect(bodyOf(fetchMock.mock.calls[0]!).event).toBe('missed-slot');
    });
  });
});

describe('alerts — streak threshold (onStreak)', () => {
  const webhook = { url: 'https://hooks.example.com/ops' };
  /** A failing terminal run with `n` failures already recorded before it. */
  const failAt = (previousFailures: number) => [makeRun(), { previousFailures }] as const;
  const ctx = (previousFailures: number) => ({ previousFailures });

  it('onStreak=1 (default) is today’s behaviour: every terminal failure alerts', async () => {
    const { alerts, fetchMock } = makeAlerts({ webhook }, async () => ok());

    await alerts.handleFinal(makeRun(), ctx(0));
    await alerts.handleFinal(makeRun(), ctx(1));
    await alerts.handleFinal(makeRun({ status: 'succeeded', error: null }), ctx(0));

    expect(fetchMock).toHaveBeenCalledTimes(2); // two failures; 'succeeded' is not in `on`
    expect(bodyOf(fetchMock.mock.calls[0]!).consecutiveFailures).toBe(1);
    expect(bodyOf(fetchMock.mock.calls[1]!).consecutiveFailures).toBe(2);
  });

  it('fires exactly at onStreak and stays silent inside the streak', async () => {
    const { alerts, fetchMock } = makeAlerts({ onStreak: 3, webhook }, async () => ok());

    await alerts.handleFinal(...failAt(0)); // 1st of the streak — below the threshold
    await alerts.handleFinal(...failAt(1)); // 2nd
    expect(fetchMock).not.toHaveBeenCalled();

    await alerts.handleFinal(...failAt(2)); // 3rd — the crossing run
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = bodyOf(fetchMock.mock.calls[0]!);
    expect(payload.event).toBe('run.failed');
    expect(payload.consecutiveFailures).toBe(3);

    await alerts.handleFinal(...failAt(3)); // 4th — one alert per streak, no reminders
    await alerts.handleFinal(...failAt(9));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-arms after the streak is broken by a success', async () => {
    const { alerts, fetchMock } = makeAlerts({ on: ['failed', 'succeeded'], onStreak: 2, webhook }, async () => ok());

    await alerts.handleFinal(...failAt(0)); // 1st
    await alerts.handleFinal(...failAt(1)); // 2nd → fires
    await alerts.handleFinal(makeRun({ status: 'succeeded', error: null }), ctx(2)); // breaks the streak
    await alerts.handleFinal(...failAt(0)); // new incident, 1st — silent
    expect(fetchMock).toHaveBeenCalledTimes(2); // the 2nd failure + the success

    await alerts.handleFinal(...failAt(1)); // new incident, 2nd → fires again
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(bodyOf(fetchMock.mock.calls[2]!).consecutiveFailures).toBe(2);
  });

  it('sends «отпустило» as run.succeeded + previousFailures after a streak ≥ onStreak', async () => {
    const { alerts, fetchMock } = makeAlerts({ on: ['failed', 'succeeded'], onStreak: 3, webhook }, async () => ok());

    await alerts.handleFinal(makeRun({ status: 'succeeded', error: null }), ctx(3));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = bodyOf(fetchMock.mock.calls[0]!);
    expect(payload.event).toBe('run.succeeded');
    expect(payload.previousFailures).toBe(3);
    expect(payload).not.toHaveProperty('consecutiveFailures');
  });

  it('a success below the threshold is a plain run.succeeded (no previousFailures)', async () => {
    const { alerts, fetchMock } = makeAlerts({ on: ['failed', 'succeeded'], onStreak: 3, webhook }, async () => ok());

    await alerts.handleFinal(makeRun({ status: 'succeeded', error: null }), ctx(0));
    await alerts.handleFinal(makeRun({ status: 'succeeded', error: null }), ctx(2));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock.mock.calls[0]!)).not.toHaveProperty('previousFailures');
    expect(bodyOf(fetchMock.mock.calls[1]!)).not.toHaveProperty('previousFailures');
  });

  it('never sends previousFailures on cancelled (a cancel is not a recovery)', async () => {
    const { alerts, fetchMock } = makeAlerts({ on: ['failed', 'cancelled'], onStreak: 2, webhook }, async () => ok());

    await alerts.handleFinal(makeRun({ status: 'cancelled', error: 'user' }), ctx(5));

    expect(fetchMock).toHaveBeenCalledTimes(1); // today’s cancelled alert, unchanged
    const payload = bodyOf(fetchMock.mock.calls[0]!);
    expect(payload.event).toBe('run.cancelled');
    expect(payload).not.toHaveProperty('previousFailures');
    expect(payload).not.toHaveProperty('consecutiveFailures');
  });

  it('respects `on`: «отпустило» is a run.succeeded alert, so a failed-only channel stays silent on success', async () => {
    const { alerts, fetchMock } = makeAlerts({ onStreak: 2, webhook }, async () => ok()); // on: ['failed'] by default

    await alerts.handleFinal(makeRun({ status: 'succeeded', error: null }), ctx(7));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves onStreak per task (field-wise override, root is the fallback)', async () => {
    const { alerts, fetchMock } = makeAlerts(
      { onStreak: 3, webhook, tasks: { 'task-b': { onStreak: 1 } } },
      async () => ok(),
    );

    await alerts.handleFinal(makeRun({ taskName: 'task-a' }), ctx(0)); // root: 3 → silent
    expect(fetchMock).not.toHaveBeenCalled();

    await alerts.handleFinal(makeRun({ taskName: 'task-b' }), ctx(0)); // override: 1 → fires
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetchMock.mock.calls[0]!).consecutiveFailures).toBe(1);
  });

  it('treats a run without streak context as the first failure of a streak', async () => {
    // External callers that wire handleFinal by hand get a deterministic default:
    // no context → the run counts as failure #1 (below an onStreak of 2).
    const { alerts, fetchMock } = makeAlerts({ onStreak: 2, webhook }, async () => ok());

    await alerts.handleFinal(makeRun());

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
