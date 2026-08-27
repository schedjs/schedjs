import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createProcessRunner } from '../../src/runners/process.js';
import type { TaskRecord } from '../../src/types.js';

const task = (config: Record<string, unknown>): TaskRecord => ({
  name: 'pdf-task',
  runner: 'process',
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

interface MockSpawnCall {
  args: string[];
  env?: Record<string, string> | undefined;
  cwd?: string | undefined;
  stdin: Writable;
  /** Everything written to the child's stdin (captured by the mock Writable). */
  stdinWrites: string[];
  write: (chunk: string) => void;
  endStdin: () => void;
  close: (code: number | null, signal?: string | null) => void;
  fail: (err: Error) => void;
  /** Overridable kill — proc.kill delegates here; tests hook it to close on signal. */
  kill: (sig: string) => void;
}

/** Scriptable mock child process: stream stdout in chunks, feed stdin, close with exit code. */
function mockSpawn(script: (p: MockSpawnCall) => void) {
  return (args: string[], options?: { env?: Record<string, string>; cwd?: string }) => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      stdin: Writable;
      kill: (sig: string) => void;
    };
    const stdinWrites: string[] = [];
    proc.stdout = new Readable({ read() {} });
    proc.stderr = new Readable({ read() {} });
    proc.stdin = new Writable({
      write(chunk: unknown, _enc: unknown, cb: () => void) {
        stdinWrites.push(String(chunk));
        cb();
      },
    });
    const call: MockSpawnCall = {
      args,
      env: options?.env,
      cwd: options?.cwd,
      stdin: proc.stdin,
      stdinWrites,
      write: (chunk) => proc.stdout.push(chunk),
      endStdin: () => proc.stdin.end(),
      close: (code, signal = null) => setTimeout(() => proc.emit('close', code, signal), 0),
      fail: (err) => setTimeout(() => proc.emit('error', err), 0),
      kill: () => {
        /* default: nothing — a kill alone does not close the child; tests hook it */
      },
    };
    proc.kill = (sig) => call.kill(sig);
    script(call);
    return proc;
  };
}

describe('process runner — exit-code mode', () => {
  it('spawns the exact argv (no shell) with run-metadata env + data-derived env', async () => {
    let call: MockSpawnCall | undefined;
    const runner = createProcessRunner({
      spawn: mockSpawn((p) => {
        call = p;
        p.close(0);
      }),
    });

    const outcome = await runner.run(
      task({ command: ['node', 'script.js'], args: ['--input', '42'], data: { idPickingList: 42, dryRun: true } }),
      'run-1',
      new Date('2026-08-16T09:00:00Z'),
    );

    expect(outcome.status).toBe('succeeded');
    expect(call!.args).toEqual(['node', 'script.js', '--input', '42']);
    expect(call!.env).toMatchObject({
      SCHED_RUN_ID: 'run-1',
      SCHED_TASK_NAME: 'pdf-task',
      ID_PICKING_LIST: '42',
      DRY_RUN: 'true',
      SCHED_DATA: '{"idPickingList":42,"dryRun":true}',
    });
  });

  it('static env wins over data-derived vars', async () => {
    let call: MockSpawnCall | undefined;
    const runner = createProcessRunner({
      spawn: mockSpawn((p) => {
        call = p;
        p.close(0);
      }),
    });

    await runner.run(
      task({ command: ['echo'], data: { fooBar: 1 }, env: { FOO_BAR: 'static' } }),
      'run-1',
      new Date(),
    );

    expect(call!.env!.FOO_BAR).toBe('static');
  });

  it('maps exit 0 to succeeded with captured stdout+stderr log', async () => {
    const runner = createProcessRunner({
      spawn: mockSpawn((p) => {
        p.write('out-line\n');
        p.close(0);
      }),
    });
    const outcome = await runner.run(task({ command: ['tool'] }), 'run-1', new Date());
    expect(outcome).toEqual({ status: 'succeeded', log: 'out-line\n' });
  });

  it('maps non-zero exit to failed with exit code and log tail', async () => {
    const runner = createProcessRunner({
      spawn: mockSpawn((p) => {
        p.close(7);
      }),
    });
    const outcome = await runner.run(task({ command: ['tool'] }), 'run-1', new Date());
    expect(outcome).toEqual({ status: 'failed', error: 'exit 7: ', log: '' });
  });

  it('caps the log at maxLogKb keeping the tail', async () => {
    const big = 'x'.repeat(20_000);
    const runner = createProcessRunner({
      spawn: mockSpawn((p) => {
        p.write(big);
        p.close(0);
      }),
    });
    const outcome = await runner.run(task({ command: ['tool'], maxLogKb: 1 }), 'run-1', new Date());
    const log = (outcome as { log: string }).log;
    expect(log.length).toBeLessThanOrEqual(1024);
    expect(log.endsWith(big.slice(-1024))).toBe(true);
  });

  it('kills the process on timeout and reports cancelled', async () => {
    let kills: string[] = [];
    const runner = createProcessRunner({
      spawn: mockSpawn((p) => {
        p.kill = (sig) => {
          kills.push(sig);
          p.close(null, sig);
        };
      }),
      timeoutMs: 50,
    });
    const outcome = await runner.run(task({ command: ['hung'] }), 'run-1', new Date());
    expect(kills[0]).toBe('SIGTERM');
    expect(outcome).toEqual({ status: 'cancelled', error: 'timeout after 50ms', log: '' });
  });

  it('kills the process on user cancel (hooks.signal) and reports cancelled', async () => {
    let kills: string[] = [];
    const runner = createProcessRunner({
      spawn: mockSpawn((p) => {
        p.kill = (sig) => {
          kills.push(sig);
          p.close(null, sig);
        };
      }),
    });
    const controller = new AbortController();
    const outcomeP = runner.run(task({ command: ['hung'] }), 'run-1', new Date(), {
      signal: controller.signal,
    });
    controller.abort(); // POST /runs/:id/cancel → engine.cancelRun → signal
    const outcome = await outcomeP;
    expect(kills[0]).toBe('SIGTERM');
    expect(outcome).toEqual({ status: 'cancelled', error: 'cancelled by user', log: '' });
  });

  it('fails when the spawn itself errors', async () => {
    const runner = createProcessRunner({
      spawn: mockSpawn((p) => {
        p.fail(new Error('spawn node ENOENT'));
        p.close(null, null);
      }),
    });
    const outcome = await runner.run(task({ command: ['node'] }), 'run-1', new Date());
    expect(outcome.status).toBe('failed');
    expect((outcome as { error: string }).error).toContain('ENOENT');
  });

  it('fails fast on missing command', async () => {
    const runner = createProcessRunner({ spawn: mockSpawn(() => {}) });
    const outcome = await runner.run(task({} as Record<string, unknown>), 'run-1', new Date());
    expect(outcome).toEqual({ status: 'failed', error: 'process runner: missing config.command' });
  });

  it('fails fast when command is an empty array', async () => {
    const runner = createProcessRunner({ spawn: mockSpawn(() => {}) });
    const outcome = await runner.run(task({ command: [] }), 'run-1', new Date());
    expect(outcome.status).toBe('failed');
  });

  it('enforces the runner ceiling (allowedTools): rejects without spawning', async () => {
    let spawned = false;
    const runner = createProcessRunner({
      spawn: (() => {
        spawned = true;
        const p = mockSpawn((c) => c.close(0))([] as unknown as string[]);
        return p;
      }) as never,
      allowedTools: ['node', 'python3', 'powershell*'],
    });

    const blocked = await runner.run(task({ command: ['bash', 'evil.sh'] }), 'run-1', new Date());
    expect(spawned).toBe(false);
    expect(blocked).toEqual({ status: 'failed', error: expect.stringContaining('allowedTools') as unknown as string });

    const allowed = await runner.run(task({ command: ['node', 'ok.js'] }), 'run-2', new Date());
    expect(spawned).toBe(true);
    expect(allowed.status).toBe('succeeded');
  });

  it('enforces per-task allowedTools: the task cannot run what it did not declare', async () => {
    let spawned = false;
    const runner = createProcessRunner({
      spawn: (() => {
        spawned = true;
        const p = mockSpawn((c) => c.close(0))([] as unknown as string[]);
        return p;
      }) as never,
    });

    const blocked = await runner.run(
      task({ command: ['bash', 'evil.sh'], allowedTools: ['node'] }),
      'run-1',
      new Date(),
    );
    expect(spawned).toBe(false);
    expect(blocked).toEqual({ status: 'failed', error: expect.stringContaining('allowedTools') as unknown as string });

    const allowed = await runner.run(task({ command: ['node', 'ok.js'], allowedTools: ['node'] }), 'run-2', new Date());
    expect(spawned).toBe(true);
    expect(allowed.status).toBe('succeeded');
  });

  it('validateConfig rejects missing command, non-allowlisted commands, and ceiling-subset violations at load time', () => {
    const runner = createProcessRunner({ allowedTools: ['node', 'python3'] });
    expect(() => runner.validateConfig?.({ name: 'bad', config: {} })).toThrow(/missing config.command/);
    expect(() => runner.validateConfig?.({ name: 'bad2', config: { command: ['sh', '-c', 'x'] } })).toThrow(/allowedTools/);
    expect(() => runner.validateConfig?.({ name: 'ok', config: { command: ['node', 'x.js'] } })).not.toThrow();
    // policy before mechanics: a ceiling-subset violation fails even with a valid command
    expect(() =>
      runner.validateConfig?.({ name: 'evil', config: { command: ['node', 'x.js'], allowedTools: ['bash'] } }),
    ).toThrow(/not a subset/);
    expect(() =>
      runner.validateConfig?.({ name: 'evil2', config: { command: ['node', 'x.js'], allowedTools: 'node' } }),
    ).toThrow(/array of non-empty strings/);
  });

  it('fails fast at load time when two data keys map to the same env var', () => {
    const runner = createProcessRunner({ allowedTools: ['node'] });
    expect(() =>
      runner.validateConfig?.({ name: 'collide', config: { command: ['node'], data: { fooBar: 1, foo_bar: 2 } } }),
    ).toThrow(/FOO_BAR/);
  });
});

describe('process runner — reference worker round-trip (real subprocess)', () => {
  const workerPath = fileURLToPath(new URL('../../../../examples/stdio-worker.mjs', import.meta.url));

  it('speaks the stdio contract end-to-end with the reference worker', async () => {
    const runner = createProcessRunner(); // real spawn
    const outcome = await runner.run(
      task({ command: [process.execPath, workerPath], envelope: true, data: { workMs: 10 } }),
      'run-rt',
      new Date(),
    );
    expect(outcome.status).toBe('succeeded');
    expect((outcome as { result: { task: string; data: { workMs: number } } }).result).toEqual({
      task: 'pdf-task',
      data: { workMs: 10 },
    });
    expect((outcome as { progress: number }).progress).toBe(100);
    expect((outcome as { log: string }).log).toContain('reference worker');
  });

  it('maps a failing worker (terminal failed envelope) to a failed run', async () => {
    const runner = createProcessRunner();
    const outcome = await runner.run(
      task({ command: [process.execPath, workerPath], envelope: true, data: { workMs: 5, fail: true } }),
      'run-rt-fail',
      new Date(),
    );
    expect(outcome.status).toBe('failed');
    expect((outcome as { error: string }).error).toBe('worker failed on purpose');
  });

  it('round-trips in exit-code mode too (worker exits 0 without the contract)', async () => {
    const runner = createProcessRunner();
    const outcome = await runner.run(
      task({ command: [process.execPath, '-e', 'process.stdout.write("plain output")'] }),
      'run-ec',
      new Date(),
    );
    expect(outcome.status).toBe('succeeded');
    expect((outcome as { log: string }).log).toContain('plain output');
  });
});

describe('process runner — envelope mode (stdio contract)', () => {
  it('writes the request envelope on stdin: { task, data }', async () => {
    let call: MockSpawnCall | undefined;
    const runner = createProcessRunner({
      spawn: mockSpawn((p) => {
        call = p;
        p.close(0);
      }),
    });

    await runner.run(
      task({ command: ['worker.mjs'], envelope: true, data: { idPickingList: 42 } }),
      'run-1',
      new Date(),
    );

    const req = JSON.parse(call!.stdinWrites.join('')) as { task: { name: string }; data: { idPickingList: number } };
    expect(req.task.name).toBe('pdf-task');
    expect(req.data).toEqual({ idPickingList: 42 });
  });

  it('parses a terminal succeeded envelope into the outcome (result/progress/log/artifacts)', async () => {
    const runner = createProcessRunner({
      spawn: mockSpawn((p) => {
        p.write(JSON.stringify({ status: 'succeeded', result: { rows: 42 }, progress: 100, log: 'done', artifacts: [{ kind: 's3', ref: 's3://b/k', label: 'R' }] }) + '\n');
        p.close(0);
      }),
    });
    const outcome = await runner.run(task({ command: ['worker.mjs'], envelope: true }), 'run-1', new Date());
    expect(outcome).toEqual({
      status: 'succeeded',
      result: { rows: 42 },
      progress: 100,
      log: 'done',
      artifacts: [{ kind: 's3', ref: 's3://b/k', label: 'R' }],
    });
  });

  it('parses a terminal failed envelope into the outcome with error', async () => {
    const runner = createProcessRunner({
      spawn: mockSpawn((p) => {
        p.write(JSON.stringify({ status: 'failed', error: 'BOOM' }) + '\n');
        p.close(3);
      }),
    });
    const outcome = await runner.run(task({ command: ['worker.mjs'], envelope: true }), 'run-1', new Date());
    expect(outcome).toEqual({ status: 'failed', error: 'BOOM' });
  });

  it('tracks intermediate running envelopes and stores the last progress in the terminal outcome', async () => {
    const runner = createProcessRunner({
      spawn: mockSpawn((p) => {
        p.write(JSON.stringify({ status: 'running', progress: 25 }) + '\n');
        p.write(JSON.stringify({ status: 'running', progress: 60 }) + '\n');
        p.write(JSON.stringify({ status: 'succeeded', progress: 100 }) + '\n');
        p.close(0);
      }),
    });
    const outcome = await runner.run(task({ command: ['worker.mjs'], envelope: true }), 'run-1', new Date());
    expect(outcome).toEqual({ status: 'succeeded', progress: 100 });
  });

  it('fails the run on a non-envelope stdout line (protocol violation)', async () => {
    const runner = createProcessRunner({
      spawn: mockSpawn((p) => {
        p.write('hello world\n');
        p.close(0);
      }),
    });
    const outcome = await runner.run(task({ command: ['worker.mjs'], envelope: true }), 'run-1', new Date());
    expect(outcome.status).toBe('failed');
    expect((outcome as { error: string }).error).toMatch(/envelope|protocol/i);
  });

  it('fails the run when the process exits without a terminal envelope', async () => {
    const runner = createProcessRunner({
      spawn: mockSpawn((p) => {
        p.write(JSON.stringify({ status: 'running', progress: 10 }) + '\n');
        p.close(0);
      }),
    });
    const outcome = await runner.run(task({ command: ['worker.mjs'], envelope: true }), 'run-1', new Date());
    expect(outcome.status).toBe('failed');
    expect((outcome as { error: string }).error).toMatch(/terminal envelope/i);
  });

  it('keeps stderr out of the protocol channel — stderr lines land in the log, not the parser', async () => {
    const runner = createProcessRunner({
      spawn: (args: string[], options?: { env?: Record<string, string>; cwd?: string }) => {
        const proc = new EventEmitter() as EventEmitter & {
          stdout: Readable;
          stderr: Readable;
          stdin: Writable;
          kill: (sig: string) => void;
        };
        proc.stdout = new Readable({ read() {} });
        proc.stderr = new Readable({ read() {} });
        proc.stdin = new Writable({ write(_c: unknown, _e: unknown, cb: () => void) { cb(); } });
        proc.kill = () => {};
        proc.stdout.push(JSON.stringify({ status: 'succeeded', log: 'protocol-ok' }) + '\n');
        proc.stdout.push(null);
        proc.stderr.push('worker: warning on stderr\n');
        proc.stderr.push(null);
        setTimeout(() => proc.emit('close', 0, null), 0);
        void args;
        void options;
        return proc;
      },
    });
    const outcome = await runner.run(task({ command: ['worker.mjs'], envelope: true }), 'run-1', new Date());
    expect(outcome.status).toBe('succeeded');
    const log = (outcome as { log: string }).log;
    expect(log).toContain('protocol-ok'); // envelope's own log field
    expect(log).toContain('worker: warning on stderr'); // stderr captured separately
  });
});
