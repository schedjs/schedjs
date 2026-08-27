import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkerFixture } from './fixtures/worker.mjs';

/**
 * check-worker conformance tests: spawn the compiled @schedjs/cli bin pointed
 * at a fixture worker and assert the 6-scenario verdict + exit codes
 * (0 all pass / 1 a scenario failed / 2 usage).
 */
const BIN = fileURLToPath(new URL('../dist/index.js', import.meta.url));

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCheckWorker(args: string[], timeoutMs = 15_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'check-worker', ...args], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`check-worker hung: stdout=${stdout.slice(-500)} stderr=${stderr.slice(-500)}`));
    }, timeoutMs);
    child.on('close', () => clearTimeout(timer));
  });
}

describe('check-worker (fixture worker, 6 scenarios)', () => {
  it('conformant worker → all scenarios PASS, exit 0', async () => {
    const worker = createWorkerFixture();
    const port = await worker.listen();
    try {
      const res = await runCheckWorker([`http://127.0.0.1:${port}`]);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('sync success');
      expect(res.stdout).toContain('sync failure');
      expect(res.stdout).toContain('async lifecycle');
      expect(res.stdout).toContain('run-id idempotency');
      expect(res.stdout).toContain('dirty input');
      expect(res.stdout).toContain('6/6 PASS');
    } finally {
      await worker.close();
    }
  });

  it('--json: machine-readable verdict object', async () => {
    const worker = createWorkerFixture();
    const port = await worker.listen();
    try {
      const res = await runCheckWorker([`http://127.0.0.1:${port}`, '--json']);
      expect(res.code).toBe(0);
      const body = JSON.parse(res.stdout);
      expect(body.ok).toBe(true);
      expect(body.pass).toBe(6);
      expect(body.fail).toBe(0);
      expect(body.scenarios).toHaveLength(6);
    } finally {
      await worker.close();
    }
  });

  it('auth worker + --api-key → PASS; without key → auth scenario FAILs, exit 1', async () => {
    const worker = createWorkerFixture({ apiKey: 'worker-secret' });
    const port = await worker.listen();
    try {
      const withKey = await runCheckWorker([`http://127.0.0.1:${port}`, '--api-key', 'worker-secret']);
      expect(withKey.code).toBe(0);
      expect(withKey.stdout).toContain('6/6 PASS');

      const withoutKey = await runCheckWorker([`http://127.0.0.1:${port}`]);
      expect(withoutKey.code).toBe(1);
      expect(withoutKey.stdout).toContain('auth');
      expect(withoutKey.stdout).toContain('FAIL');
    } finally {
      await worker.close();
    }
  });

  it('broken sync worker (reports succeeded on fail) → sync-failure scenario FAILs, exit 1', async () => {
    const worker = createWorkerFixture({ brokenSync: true });
    const port = await worker.listen();
    try {
      const res = await runCheckWorker([`http://127.0.0.1:${port}`]);
      expect(res.code).toBe(1);
      expect(res.stdout).toContain('sync failure');
      expect(res.stdout).toContain('FAIL');
    } finally {
      await worker.close();
    }
  });

  it('hung async worker → async scenario FAILs via timeout trap, exit 1', async () => {
    const worker = createWorkerFixture({ hangAsync: true });
    const port = await worker.listen();
    try {
      const res = await runCheckWorker([`http://127.0.0.1:${port}`, '--timeout', '2']);
      expect(res.code).toBe(1);
      expect(res.stdout).toContain('async lifecycle');
      expect(res.stdout).toContain('FAIL');
    } finally {
      await worker.close();
    }
  });

  it('unreachable worker → connect error → FAIL, exit 1', async () => {
    const worker = createWorkerFixture();
    const port = await worker.listen();
    await worker.close(); // free the port: nothing listens there now
    const res = await runCheckWorker([`http://127.0.0.1:${port}`]);
    expect(res.code).toBe(1);
  });

  it('F3: a second run against the SAME worker passes (run-ids are per-invocation)', async () => {
    // the fixture caches terminal outcomes by run-id (that IS the idempotency
    // contract) — fixed ids would make the second async dispatch hit the cached
    // terminal envelope instead of 202 → the regression the admin found.
    const worker = createWorkerFixture();
    const port = await worker.listen();
    try {
      const first = await runCheckWorker([`http://127.0.0.1:${port}`]);
      expect(first.code).toBe(0);
      const second = await runCheckWorker([`http://127.0.0.1:${port}`]);
      expect(second.code).toBe(0);
      expect(second.stdout).toContain('6/6 PASS');
    } finally {
      await worker.close();
    }
  }, 30_000);

  it('usage: missing url → exit 2 with usage text', async () => {
    const res = await runCheckWorker([]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('check-worker <url>');
  });
});
