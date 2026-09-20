import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createAlerts } from '../src/alerts.js';
import { createEngine } from '../src/engine.js';
import type { RunFinalContext, RunOutcome, Runner } from '../src/engine.js';
import { makeTask } from '../src/storage-contract.js';
import type { RunRecord } from '../src/types.js';
import { MemoryStorage } from './helpers/memory-storage.js';

/**
 * End-to-end local contour: engine → alerts → a LIVE HTTP receiver on
 * 127.0.0.1 (no external network, deterministic — CI level).
 *
 * The unit suite (alerts.test.ts) pins the payload contract with a mocked
 * `fetch`; this one proves the same contract survives the real path: a real
 * runner outcome, a real terminal write, the real engine streak context
 * (`RunFinalContext`), a real HMAC signature over the wire and — the point of
 * R1 — exactly ONE message per failure streak, plus «отпустило» on the success
 * that ends it.
 */

interface Received {
  /** Parsed JSON payload, as the receiver would route on it. */
  body: Record<string, unknown>;
  /** Exact bytes, so the HMAC signature can be re-computed externally. */
  raw: string;
  signature: string | undefined;
}

async function startReceiver(): Promise<{ received: Received[]; url: string; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      received.push({
        body: JSON.parse(raw) as Record<string, unknown>,
        raw,
        signature: req.headers['x-sched-signature-256'] as string | undefined,
      });
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    received,
    url: `http://127.0.0.1:${port}/alerts`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const SECRET = 'whsec_e2e_local';
const TASK = 'books-nightly';

/** Engine whose runner replays a scripted outcome list (one entry per run). */
function scriptedEngine(
  script: RunOutcome[],
  onRunFinal: (run: RunRecord, context: RunFinalContext) => void | Promise<void>,
): { run: () => Promise<RunRecord> } {
  const storage = new MemoryStorage();
  // The engine drives tasks out of storage — seed the task row directly
  // (MemoryStorage exposes its maps for inspection, mirroring engine.test.ts).
  storage.tasks.set(TASK, makeTask({ name: TASK, runner: 'process' }));
  const runner: Runner = {
    async run(): Promise<RunOutcome> {
      return script.shift() ?? { status: 'succeeded' };
    },
  };
  const engine = createEngine({ storage, runner, onRunFinal });
  return {
    run: async () => {
      const record = await engine.triggerTask(TASK);
      if (!record) throw new Error(`triggerTask(${TASK}) returned null`);
      return record;
    },
  };
}

const failed = (): RunOutcome => ({ status: 'failed', error: 'worker exited 1' });
const succeeded = (): RunOutcome => ({ status: 'succeeded' });

describe('alerts — e2e local contour (engine + live webhook receiver)', () => {
  let closeReceiver: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await closeReceiver?.();
    closeReceiver = null;
  });

  it('one message per failure streak, then «отпустило» on the success that ends it', async () => {
    const receiver = await startReceiver();
    closeReceiver = receiver.close;

    const alerts = createAlerts({
      on: ['failed', 'succeeded'],
      onStreak: 3,
      webhook: { url: receiver.url, secret: SECRET },
    });
    const { run } = scriptedEngine(
      // four failures in a row, then the run that releases the streak, then the
      // first failure of the NEXT incident (must be silent — the gate re-armed).
      [failed(), failed(), failed(), failed(), succeeded(), failed()],
      (record, context) => alerts.handleFinal(record, context),
    );

    // 1st and 2nd failure — inside the streak, the channel stays quiet
    await run();
    await run();
    expect(receiver.received).toHaveLength(0);

    // 3rd failure — the crossing run fires exactly one message
    const crossing = await run();
    expect(receiver.received).toHaveLength(1);
    const message = receiver.received[0]!;
    expect(message.body.event).toBe('run.failed');
    expect(message.body.consecutiveFailures).toBe(3);
    expect(message.body.task).toEqual({ name: TASK, runner: 'process' });
    expect((message.body.run as Record<string, unknown>).id).toBe(crossing.id);
    expect(message.signature).toBe(
      `sha256=${createHmac('sha256', SECRET).update(message.raw).digest('hex')}`,
    );

    // 4th failure — same streak, no reminders (a task red for a week is one message)
    await run();
    expect(receiver.received).toHaveLength(1);

    // success — «отпустило» carries how long the incident lasted
    const recovery = await run();
    expect(receiver.received).toHaveLength(2);
    const release = receiver.received[1]!;
    expect(release.body.event).toBe('run.succeeded');
    expect(release.body.previousFailures).toBe(4);
    expect(release.body).not.toHaveProperty('consecutiveFailures');
    expect((release.body.run as Record<string, unknown>).id).toBe(recovery.id);

    // the next incident re-arms: its first failure is below the threshold again
    await run();
    expect(receiver.received).toHaveLength(2);
  });

  it('onStreak=1 (default config) keeps today’s wire behaviour: every terminal failure is a message', async () => {
    const receiver = await startReceiver();
    closeReceiver = receiver.close;

    const alerts = createAlerts({ webhook: { url: receiver.url } }); // defaults: on ['failed'], onStreak 1
    const { run } = scriptedEngine([failed(), failed(), succeeded()], (record, context) =>
      alerts.handleFinal(record, context),
    );

    await run();
    await run();
    await run();

    expect(receiver.received).toHaveLength(2); // both failures, no success alert by default
    expect(receiver.received.map((r) => r.body.event)).toEqual(['run.failed', 'run.failed']);
    expect(receiver.received.map((r) => r.body.consecutiveFailures)).toEqual([1, 2]);
    expect(receiver.received.map((r) => r.signature)).toEqual([undefined, undefined]); // no secret → no signature
  });
});
