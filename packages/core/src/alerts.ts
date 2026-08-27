import { createHmac } from 'node:crypto';
import type { EngineEvent } from './engine.js';
import type { RunRecord, RunStatus } from './types.js';

/**
 * Status alerts — platform-level notifications about run terminal states.
 *
 * Ownership (see .wiki/concepts/artifacts-responsibility.md): status alerts are the
 * scheduler's job (Airflow email_on_failure / Cronitor model) — *content* emails and
 * artifact generation belong to the runner. This module only signals *that* a run
 * finished and how, plus schedule slots that fired late (missed-slot).
 *
 * Channel: a single universal outbound webhook (HTTP POST + JSON) — the de-facto
 * standard every external world speaks (Slack/Discord/Teams/Telegram/ntfy/PagerDuty
 * are all POSTs with different JSON). Delivery is best-effort with bounded retry:
 * a failing channel logs and never fails the run flow.
 *
 * Wiring (engine seams): `handleFinal` goes to `onRunFinal`, `handleEvent` to
 * `onEvent` (it filters missed-slot internally).
 */
export interface WebhookChannelConfig {
  /** Endpoint to POST the JSON payload to. */
  url: string;
  /**
   * HMAC-SHA256 secret. When set, sched signs the exact request body and sends
   * `X-Sched-Signature-256: sha256=<hex>` (GitHub webhook model) so the consumer
   * can verify authenticity. Omit → no signature.
   */
  secret?: string;
  /** Extra headers, e.g. `{ 'X-Ops-Token': '…' }` for services that require one. */
  headers?: Record<string, string>;
  /** Per-attempt timeout in ms. Default: 10_000. */
  timeoutMs?: number;
}

export interface AlertsConfig {
  /** Which terminal run statuses trigger a webhook. Default: ['failed']. */
  on?: RunStatus[];
  /**
   * Alert when a schedule slot fired later than the engine's missed-slot grace
   * window (downtime catch-up, wedged lock). Default: true.
   */
  onMissed?: boolean;
  /**
   * Alert when the daemon's tasks.json sync fails (the scheduler's own
   * health signal — a dead storage pool means NOTHING schedules, and a
   * run.failed alert can never fire because no runs start). Fires once per
   * failure streak (dedupe: only `consecutiveFailures === 1` reaches the
   * webhook — a mongo that stays down for a day does not spam 1440 POSTs).
   * Default: true.
   */
  onSyncFailed?: boolean;
  webhook?: WebhookChannelConfig;
  /**
   * Per-task routing overrides (multi-tenant: critical vs cosmetic tasks have
   * different noise budgets). Field-wise merge over the root config — the task
   * wins; **arrays REPLACE, never concat** (`on: []` = silence this task).
   * A task with its own `webhook` routes to THAT channel (escape hatch for
   * criticality≠channel), otherwise the root webhook applies.
   */
  tasks?: Record<string, Partial<AlertsConfig>>;
}

export interface AlertDeps {
  fetch?: typeof fetch;
  /** Injectable backoff sleep (tests). Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export interface Alerts {
  /** Terminal run statuses (engine `onRunFinal` seam). Never throws. */
  handleFinal(run: RunRecord): Promise<void>;
  /** Engine event stream (engine `onEvent` seam); filters missed-slot internally. Never throws. */
  handleEvent(event: EngineEvent): Promise<void>;
}

const DEFAULT_ON: RunStatus[] = ['failed'];
const DEFAULT_TIMEOUT_MS = 10_000;
/** Backoff between attempts; attempts total = delays + 1 (3). */
const RETRY_DELAYS_MS = [5_000, 30_000];
const SIGNATURE_HEADER = 'X-Sched-Signature-256';

type MissedSlotEvent = Extract<EngineEvent, { type: 'missed-slot' }>;
type SyncFailedEvent = Extract<EngineEvent, { type: 'sync-failed' }>;

function eventName(status: RunStatus): string {
  return `run.${status}`;
}

function runPayload(run: RunRecord): Record<string, unknown> {
  return {
    version: 1,
    event: eventName(run.status),
    task: { name: run.taskName, runner: run.runner },
    run: {
      id: run.id,
      status: run.status,
      attempt: run.attempt,
      error: run.error ?? undefined,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    },
  };
}

function missedPayload(e: MissedSlotEvent): Record<string, unknown> {
  return {
    version: 1,
    event: 'missed-slot',
    task: { name: e.taskName, runner: e.runner },
    schedule: { id: e.scheduleId, scheduledAt: e.scheduledAt.toISOString(), delayMs: e.delayMs },
  };
}

function syncFailedPayload(e: SyncFailedEvent): Record<string, unknown> {
  return {
    version: 1,
    event: 'sync.failed',
    error: e.error,
    consecutiveFailures: e.consecutiveFailures,
  };
}

export function createAlerts(config: AlertsConfig = {}, deps: AlertDeps = {}): Alerts {
  const fetchImpl = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /**
   * Field-wise per-task resolution: task override ?? root ?? default.
   * Arrays REPLACE (a task `on: []` silences it regardless of the root).
   */
  function resolveFor(taskName: string): { on: RunStatus[]; onMissed: boolean; webhook: WebhookChannelConfig | undefined } {
    const t = config.tasks?.[taskName];
    return {
      on: t?.on ?? config.on ?? DEFAULT_ON,
      onMissed: t?.onMissed ?? config.onMissed ?? true,
      webhook: t?.webhook ?? config.webhook,
    };
  }

  /**
   * POST a payload with bounded retry: 3 attempts, backoff 5s/30s.
   * Retries: network errors, timeouts, 5xx. NOT 4xx (config error on our side —
   * retrying is pointless). Exhausted → console.error. Never throws.
   */
  async function post(webhook: WebhookChannelConfig, payload: Record<string, unknown>): Promise<void> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...webhook.headers,
    };
    if (webhook.secret) {
      headers[SIGNATURE_HEADER] = `sha256=${createHmac('sha256', webhook.secret).update(body).digest('hex')}`;
    }
    const timeoutMs = webhook.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
      try {
        const res = await fetchImpl(webhook.url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) return;
        if (res.status >= 400 && res.status < 500) {
          console.error(`[alerts] webhook ${webhook.url} rejected ${payload.event} with ${res.status} — not retrying`);
          return;
        }
        // 5xx — retryable, fall through to backoff
      } catch {
        // network error / timeout — retryable
      }
      if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]!);
    }
    console.error(`[alerts] webhook ${webhook.url} failed after ${RETRY_DELAYS_MS.length + 1} attempts (${payload.event})`);
  }

  return {
    async handleFinal(run) {
      const r = resolveFor(run.taskName);
      if (!r.webhook || !r.on.includes(run.status)) return;
      await post(r.webhook, runPayload(run)).catch((e) =>
        console.error(`[alerts] webhook failed for run ${run.id}:`, e),
      );
    },
    async handleEvent(event) {
      if (event.type === 'missed-slot') {
        const r = resolveFor(event.taskName);
        if (!r.webhook || !r.onMissed) return;
        await post(r.webhook, missedPayload(event)).catch((e) =>
          console.error(`[alerts] webhook failed for missed-slot ${event.scheduleId}:`, e),
        );
        return;
      }
      if (event.type === 'sync-failed') {
        // Sync health is daemon-global, not per-task — no task routing here.
        const onSyncFailed = config.onSyncFailed ?? true;
        if (!onSyncFailed || !config.webhook) return;
        // Dedupe: only the first failure of a streak POSTs. A down mongo pool
        // otherwise spams one alert per sync interval (default 60 s) — the
        // operator already knows after the first one.
        if (event.consecutiveFailures > 1) return;
        await post(config.webhook, syncFailedPayload(event)).catch((e) =>
          console.error(`[alerts] webhook failed for sync-failed:`, e),
        );
        return;
      }
    },
  };
}
