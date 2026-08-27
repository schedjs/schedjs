import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createDockerRunner } from '../../src/runners/docker.js';
import { dockerToolAllowed } from '../../src/allowlist.js';
import type { TaskRecord } from '../../src/types.js';

const task = (config: Record<string, unknown>): TaskRecord => ({
  name: 'pdf-task',
  runner: 'docker',
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

class MockProc extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  stdinWrites: string[] = [];
  killCalls: string[] = [];
  constructor(out = '', err = '', private readonly afterKill?: () => void) {
    super();
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });
    this.stdin = new Writable({
      write: (chunk: unknown, _enc: unknown, cb: () => void) => {
        this.stdinWrites.push(String(chunk));
        cb();
      },
    });
    if (out) this.stdout.push(out);
    if (err) this.stderr.push(err);
    this.stdout.push(null);
    this.stderr.push(null);
  }
  kill(sig: string): void {
    this.killCalls.push(sig);
    this.afterKill?.();
  }
  close(code: number | null, signal: string | null = null): void {
    setTimeout(() => this.emit('close', code, signal), 0);
  }
  fail(err: Error): void {
    setTimeout(() => this.emit('error', err), 0);
  }
}

describe('docker runner', () => {
  it('spawns `docker run --rm` with run metadata env, image and args', async () => {
    let spawnedArgs: string[] | null = null;
    const spawnMock = (args: string[]) => {
      spawnedArgs = args;
      const p = new MockProc();
      p.close(0);
      return p;
    };
    const runner = createDockerRunner({ spawn: spawnMock });

    const outcome = await runner.run(
      task({ image: 'myregistry/tool', tag: 'master', args: ['--input', '42'] }),
      'run-1',
      new Date('2026-08-16T09:00:00Z'),
    );

    expect(outcome).toEqual({ status: 'succeeded', log: '' });
    expect(spawnedArgs).toEqual([
      'run', '--rm', '--name', 'sched-run-1',
      '-e', 'SCHED_RUN_ID=run-1',
      '-e', 'SCHED_TASK_NAME=pdf-task',
      'myregistry/tool:master', '--input', '42',
    ]);
  });

  it('passes --network <name> when config.network is set (docker run joins the given network)', async () => {
    let spawnedArgs: string[] | null = null;
    const spawnMock = (args: string[]) => {
      spawnedArgs = args;
      const p = new MockProc();
      p.close(0);
      return p;
    };
    const runner = createDockerRunner({ spawn: spawnMock });

    const outcome = await runner.run(
      task({ image: 'myregistry/tool', network: 'proxy' }),
      'run-1',
      new Date(),
    );

    expect(outcome).toEqual({ status: 'succeeded', log: '' });
    expect(spawnedArgs).toEqual([
      'run', '--rm', '--name', 'sched-run-1',
      '--network', 'proxy',
      '-e', 'SCHED_RUN_ID=run-1',
      '-e', 'SCHED_TASK_NAME=pdf-task',
      'myregistry/tool:latest',
    ]);
  });

  it('defaults the tag to latest and passes static env + data-derived env', async () => {
    let spawnedArgs: string[] | null = null;
    const spawnMock = (args: string[]) => {
      spawnedArgs = args;
      const p = new MockProc();
      p.close(0);
      return p;
    };
    const runner = createDockerRunner({ spawn: spawnMock });

    await runner.run(
      task({ image: 'tool', env: { FOO: 'bar', WEB_URL: 'https://x' }, data: { idPickingList: 42, dryRun: true, nested: { a: 1 } } }),
      'run-1',
      new Date(),
    );

    const args = spawnedArgs!;
    expect(args).toContain('-e');
    expect(args).toContain('FOO=bar');
    expect(args).toContain('WEB_URL=https://x');
    expect(args).toContain('ID_PICKING_LIST=42');
    expect(args).toContain('DRY_RUN=true');
    expect(args).toContain('SCHED_DATA={"idPickingList":42,"dryRun":true,"nested":{"a":1}}');
    expect(args).toContain('tool:latest');
  });

  it('captures stdout+stderr into log (ring-buffered to maxLogKb)', async () => {
    const spawnMock = (): MockProc => {
      const p = new MockProc('out-line\n', 'err-line\n');
      p.close(0);
      return p;
    };
    const runner = createDockerRunner({ spawn: spawnMock });

    const outcome = await runner.run(task({ image: 'tool', maxLogKb: 1 }), 'run-1', new Date());

    expect(outcome.status).toBe('succeeded');
    expect((outcome as { log: string }).log).toContain('out-line');
    expect((outcome as { log: string }).log).toContain('err-line');
  });

  it('caps the log at maxLogKb keeping the tail', async () => {
    const big = 'x'.repeat(20_000);
    const spawnMock = (): MockProc => {
      const p = new MockProc(big);
      p.close(0);
      return p;
    };
    const runner = createDockerRunner({ spawn: spawnMock });

    const outcome = await runner.run(task({ image: 'tool', maxLogKb: 1 }), 'run-1', new Date());

    const log = (outcome as { log: string }).log;
    expect(log.length).toBeLessThanOrEqual(1024);
    expect(log.endsWith(big.slice(-1024))).toBe(true);
  });

  it('maps exit 0 to succeeded', async () => {
    const runner = createDockerRunner({
      spawn: (() => {
        const p = new MockProc('done');
        p.close(0);
        return p;
      }) as never,
    });
    const outcome = await runner.run(task({ image: 'tool' }), 'run-1', new Date());
    expect(outcome).toEqual({ status: 'succeeded', log: 'done' });
  });

  it('maps non-zero exit to failed with exit code and log tail', async () => {
    const runner = createDockerRunner({
      spawn: (() => {
        const p = new MockProc('', 'BOOM at line 3');
        p.close(7);
        return p;
      }) as never,
    });
    const outcome = await runner.run(task({ image: 'tool' }), 'run-1', new Date());
    expect(outcome).toEqual({ status: 'failed', error: 'exit 7: BOOM at line 3', log: 'BOOM at line 3' });
  });

  it('kills the container on timeout and reports cancelled', async () => {
    let proc: MockProc | null = null;
    const spawnMock = () => {
      proc = new MockProc();
      // never closes on its own — the runner must kill it
      proc.kill = (sig: string) => {
        proc!.killCalls.push(sig);
        proc!.close(null, sig === 'SIGTERM' ? 'SIGTERM' : null);
      };
      return proc;
    };
    const runner = createDockerRunner({ spawn: spawnMock, timeoutMs: 50 });

    const outcome = await runner.run(task({ image: 'tool' }), 'run-1', new Date());

    expect(proc!.killCalls[0]).toBe('SIGTERM');
    expect(outcome).toEqual({ status: 'cancelled', error: 'timeout after 50ms', log: '' });
  });

  it('timeoutMs: -1 = no timeout — the container is never auto-killed (prod defect 3: books ran with -1 and got instant "timeout after -1ms")', async () => {
    let proc: MockProc | null = null;
    const spawnMock = () => {
      proc = new MockProc();
      proc.kill = (sig: string) => {
        proc!.killCalls.push(sig);
        proc!.close(null, sig === 'SIGTERM' ? 'SIGTERM' : null);
      };
      return proc;
    };
    // task-level config.timeoutMs = -1 (docker runner config knob, not the
    // task-level run-deadline) — must be treated as "no container timeout"
    const runner = createDockerRunner({ spawn: spawnMock, timeoutMs: 50 });

    const runPromise = runner.run(task({ image: 'tool', timeoutMs: -1 }), 'run-1', new Date());
    // let the 50ms default (and more) pass — a -1 must never fire the kill timer
    await new Promise((r) => setTimeout(r, 120));
    // the container is still alive: no SIGTERM was sent
    expect(proc!.killCalls).toEqual([]);
    // simulate the worker finishing on its own — outcome maps cleanly
    proc!.close(0);
    const outcome = await runPromise;
    expect(outcome).toEqual({ status: 'succeeded', log: '' });
  });

  it('fails when the spawn itself errors (docker not installed / daemon down)', async () => {
    const spawnMock = () => {
      const p = new MockProc();
      p.fail(new Error('spawn docker ENOENT'));
      p.close(null, null);
      return p;
    };
    const runner = createDockerRunner({ spawn: spawnMock });

    const outcome = await runner.run(task({ image: 'tool' }), 'run-1', new Date());

    expect(outcome.status).toBe('failed');
    expect((outcome as { error: string }).error).toContain('ENOENT');
  });

  it('fails fast on missing config.image', async () => {
    const runner = createDockerRunner({ spawn: () => new MockProc() });
    const outcome = await runner.run(task({} as Record<string, unknown>), 'run-1', new Date());
    expect(outcome).toEqual({ status: 'failed', error: 'docker runner: missing config.image' });
  });

  it('enforces the runner ceiling (allowedTools): rejects non-allowlisted images without spawning', async () => {
    let spawned = false;
    const runner = createDockerRunner({
      spawn: () => {
        spawned = true;
        const p = new MockProc();
        p.close(0);
        return p;
      },
      allowedTools: ['registry.example.com/*'],
    });

    const blocked = await runner.run(task({ image: 'docker.io/library/evil' }), 'run-1', new Date());
    expect(spawned).toBe(false);
    expect(blocked).toEqual({ status: 'failed', error: expect.stringContaining('allowedTools') as unknown as string });

    const allowed = await runner.run(task({ image: 'registry.example.com/tool' }), 'run-2', new Date());
    expect(spawned).toBe(true);
    expect(allowed.status).toBe('succeeded');
  });

  it('allowedTools matches exact images and trailing-* patterns', async () => {
    const runner = createDockerRunner({
      spawn: (() => {
        const p = new MockProc();
        p.close(0);
        return p;
      }) as never,
      allowedTools: ['alpine:latest', 'registry.example.com/*'],
    });
    // image without tag → alpine:latest, exact match
    expect((await runner.run(task({ image: 'alpine' }), 'r1', new Date())).status).toBe('succeeded');
    expect((await runner.run(task({ image: 'registry.example.com/tool' }), 'r2', new Date())).status).toBe('succeeded');
    // tag stays as given (no double :latest); prefix pattern matches with tag
    expect((await runner.run(task({ image: 'registry.example.com/evil:master' }), 'r3', new Date())).status).toBe('succeeded');
    expect((await runner.run(task({ image: 'busybox' }), 'r4', new Date())).status).toBe('failed');
  });

  it('allowedTools restricts the explicit command (image@command specs)', async () => {
    let spawned = false;
    const runner = createDockerRunner({
      spawn: (() => {
        spawned = true;
        const p = new MockProc();
        p.close(0);
        return p;
      }) as never,
      allowedTools: ['alpine@echo'],
    });
    // image alpine with entrypoint echo → allowed
    expect((await runner.run(task({ image: 'alpine', command: ['echo', 'hi'] }), 'r1', new Date())).status).toBe('succeeded');
    expect(spawned).toBe(true);
    // same image with a different entrypoint → blocked before spawn
    spawned = false;
    const blocked = await runner.run(task({ image: 'alpine', command: ['sh', '-c', 'rm -rf /'] }), 'r2', new Date());
    expect(spawned).toBe(false);
    expect(blocked.status).toBe('failed');
    // task-level allowedTools is enforced too
    const perTask = await runner.run(
      task({ image: 'alpine', command: ['echo', 'x'], allowedTools: ['alpine@echo'] }),
      'r3',
      new Date(),
    );
    expect(perTask.status).toBe('succeeded');
  });

  it('validateConfig rejects non-allowlisted tools at load time (fail-fast before any run)', () => {
    const runner = createDockerRunner({ allowedTools: ['alpine:*'] });
    expect(() => runner.validateConfig?.({ name: 'bad', config: { image: 'busybox' } })).toThrow(/allowedTools/);
    // resolved image alpine:3.20 matches the alpine:* prefix
    expect(() => runner.validateConfig?.({ name: 'ok', config: { image: 'alpine:3.20' } })).not.toThrow();
    // tag-less image resolves to :latest and matches the prefix
    expect(() => runner.validateConfig?.({ name: 'ok2', config: { image: 'alpine' } })).not.toThrow();
    expect(() => runner.validateConfig?.({ name: 'noimg', config: {} })).toThrow(/missing config.image/);
    // policy before mechanics: a ceiling-subset violation fails even with an allowlisted image
    expect(() =>
      runner.validateConfig?.({ name: 'evil', config: { image: 'alpine', allowedTools: ['busybox'] } }),
    ).toThrow(/not a subset/);
    // prod defect 3: timeoutMs -1 = no timeout is legal; 0 / -2 / garbage fail fast
    expect(() => runner.validateConfig?.({ name: 'nt', config: { image: 'alpine', timeoutMs: -1 } })).not.toThrow();
    expect(() => runner.validateConfig?.({ name: 'z', config: { image: 'alpine', timeoutMs: 0 } })).toThrow(/timeoutMs must be -1/);
    expect(() => runner.validateConfig?.({ name: 'neg', config: { image: 'alpine', timeoutMs: -2 } })).toThrow(/timeoutMs must be -1/);
    expect(() => runner.validateConfig?.({ name: 'net', config: { image: 'alpine', network: 'proxy' } })).not.toThrow();
    expect(() => runner.validateConfig?.({ name: 'netempty', config: { image: 'alpine', network: '' } })).toThrow(/network must be a non-empty string/);
    expect(() => runner.validateConfig?.({ name: 'netnum', config: { image: 'alpine', network: 42 as unknown as string } })).toThrow(/network must be a non-empty string/);
  });
});

describe('docker runner — command argv + allowlist (peer-review regression)', () => {
  it('passes command[1..] as argv after the image (entrypoint = command[0])', async () => {
    let spawnedArgs: string[] | null = null;
    const spawnMock = (args: string[]) => {
      spawnedArgs = args;
      const p = new MockProc();
      p.close(0);
      return p;
    };
    const runner = createDockerRunner({ spawn: spawnMock });
    const outcome = await runner.run(
      task({ image: 'alpine', command: ['sh', '-c', 'echo hi'], args: ['--legacy'] }),
      'run-1',
      new Date('2026-08-16T09:00:00Z'),
    );
    expect(outcome).toEqual({ status: 'succeeded', log: '' });
    const imgIdx = spawnedArgs!.indexOf('alpine:latest');
    expect(imgIdx).toBeGreaterThan(-1);
    expect(spawnedArgs!.slice(imgIdx + 1)).toEqual(['-c', 'echo hi', '--legacy']);
    const entryIdx = spawnedArgs!.indexOf('--entrypoint');
    expect(spawnedArgs![entryIdx + 1]).toBe('sh');
  });

  it('matches an exact allowedTools pattern against the resolved :latest image (dockerToolAllowed)', () => {
    expect(dockerToolAllowed('alpine:latest', undefined, ['alpine'])).toBe(true);
    expect(dockerToolAllowed('alpine', undefined, ['alpine'])).toBe(true);
    expect(dockerToolAllowed('alpine:3.19', undefined, ['alpine'])).toBe(false);
    expect(dockerToolAllowed('alpine:3.19', undefined, ['alpine:*'])).toBe(true);
  });
});

describe('docker runner — envelope mode (stdio contract)', () => {
  const spawnFrom = (proc: MockProc) => () => {
    proc.close(0);
    return proc;
  };

  it('adds -i and writes the request envelope on stdin: { task, data }', async () => {
    let spawnedArgs: string[] | null = null;
    const proc = new MockProc();
    const spawnMock = (args: string[]) => {
      spawnedArgs = args;
      proc.close(0);
      return proc;
    };
    const runner = createDockerRunner({ spawn: spawnMock });

    await runner.run(
      task({ image: 'tool', envelope: true, data: { idPickingList: 42 } }),
      'run-1',
      new Date(),
    );

    expect(spawnedArgs).toContain('-i');
    const req = JSON.parse(proc.stdinWrites.join('')) as { task: { name: string }; data: { idPickingList: number } };
    expect(req.task.name).toBe('pdf-task');
    expect(req.data).toEqual({ idPickingList: 42 });
    // the envelope flag itself is stripped from the config echoed to the worker
    expect((req.task as { config?: Record<string, unknown> }).config?.envelope).toBeUndefined();
  });

  it('parses a terminal succeeded envelope into the outcome (result/progress/log/artifacts)', async () => {
    const proc = new MockProc(
      JSON.stringify({ status: 'succeeded', result: { rows: 7 }, progress: 100, log: 'ok', artifacts: [{ kind: 'url', ref: 'http://x/r', label: 'R' }] }) + '\n',
    );
    const runner = createDockerRunner({ spawn: spawnFrom(proc) });
    const outcome = await runner.run(task({ image: 'tool', envelope: true }), 'run-1', new Date());
    expect(outcome).toEqual({
      status: 'succeeded',
      result: { rows: 7 },
      progress: 100,
      log: 'ok',
      artifacts: [{ kind: 'url', ref: 'http://x/r', label: 'R' }],
    });
  });

  it('parses a terminal failed envelope into the outcome with error', async () => {
    const proc = new MockProc(JSON.stringify({ status: 'failed', error: 'container BOOM' }) + '\n');
    const runner = createDockerRunner({ spawn: spawnFrom(proc) });
    const outcome = await runner.run(task({ image: 'tool', envelope: true }), 'run-1', new Date());
    expect(outcome).toEqual({ status: 'failed', error: 'container BOOM' });
  });

  it('tracks intermediate running envelopes and stores the last progress in the terminal outcome', async () => {
    const proc = new MockProc(
      JSON.stringify({ status: 'running', progress: 25 }) + '\n' +
        JSON.stringify({ status: 'running', progress: 60 }) + '\n' +
        JSON.stringify({ status: 'succeeded', progress: 100 }) + '\n',
    );
    const runner = createDockerRunner({ spawn: spawnFrom(proc) });
    const outcome = await runner.run(task({ image: 'tool', envelope: true }), 'run-1', new Date());
    expect(outcome).toEqual({ status: 'succeeded', progress: 100 });
  });

  it('fails the run on a non-envelope stdout line (protocol violation)', async () => {
    const proc = new MockProc('hello world\n');
    const runner = createDockerRunner({ spawn: spawnFrom(proc) });
    const outcome = await runner.run(task({ image: 'tool', envelope: true }), 'run-1', new Date());
    expect(outcome.status).toBe('failed');
    expect((outcome as { error: string }).error).toMatch(/envelope|protocol/i);
  });

  it('fails the run when the container exits without a terminal envelope', async () => {
    const proc = new MockProc(JSON.stringify({ status: 'running', progress: 10 }) + '\n');
    const runner = createDockerRunner({ spawn: spawnFrom(proc) });
    const outcome = await runner.run(task({ image: 'tool', envelope: true }), 'run-1', new Date());
    expect(outcome.status).toBe('failed');
    expect((outcome as { error: string }).error).toMatch(/terminal envelope/i);
  });

  it('keeps stderr free: stderr lines land in the log, never the parser', async () => {
    const proc = new MockProc(JSON.stringify({ status: 'succeeded', log: 'protocol-ok' }) + '\n', 'container: warn\n');
    const runner = createDockerRunner({ spawn: spawnFrom(proc) });
    const outcome = await runner.run(task({ image: 'tool', envelope: true }), 'run-1', new Date());
    expect(outcome.status).toBe('succeeded');
    expect((outcome as { log: string }).log).toContain('protocol-ok');
    expect((outcome as { log: string }).log).toContain('container: warn');
  });

  it('exit-code mode is untouched: no -i, no stdin write, plain mapping', async () => {
    let spawnedArgs: string[] | null = null;
    const proc = new MockProc('plain-out');
    const spawnMock = (args: string[]) => {
      spawnedArgs = args;
      proc.close(0);
      return proc;
    };
    const runner = createDockerRunner({ spawn: spawnMock });
    const outcome = await runner.run(task({ image: 'tool' }), 'run-1', new Date());
    expect(spawnedArgs).not.toContain('-i');
    expect(proc.stdinWrites).toEqual([]);
    expect(outcome).toEqual({ status: 'succeeded', log: 'plain-out' });
  });
});

describe('docker runner — envFromData camelCase→SCREAMING_SNAKE collisions (peer-review)', () => {
  it('fails fast at load time when two data keys map to the same env var (fooBar vs foo_bar)', () => {
    const runner = createDockerRunner({ allowedTools: ['alpine:*'] });
    expect(() =>
      runner.validateConfig?.({ name: 'collide', config: { image: 'alpine', data: { fooBar: 1, foo_bar: 2 } } }),
    ).toThrow(/FOO_BAR/);
  });

  it('does not collide when keys are already distinct SCREAMING_SNAKE names', () => {
    const runner = createDockerRunner({ allowedTools: ['alpine:*'] });
    expect(() =>
      runner.validateConfig?.({ name: 'ok', config: { image: 'alpine', data: { idPickingList: 1, dryRun: true } } }),
    ).not.toThrow();
  });

  it('fails the run (not spawns) when a collision slips through without validateConfig', async () => {
    let spawned = false;
    const runner = createDockerRunner({
      spawn: () => {
        spawned = true;
        const p = new MockProc();
        p.close(0);
        return p;
      },
    });
    const outcome = await runner.run(
      task({ image: 'tool', data: { fooBar: 1, foo_bar: 2 } }),
      'run-1',
      new Date(),
    );
    expect(spawned).toBe(false);
    expect(outcome.status).toBe('failed');
    expect((outcome as { error: string }).error).toMatch(/FOO_BAR/);
  });

  it('reports the real spawn error even in envelope mode (peer-review: docker/process divergence)', async () => {
    // spawn itself fails (docker daemon down / binary missing) while envelope:true;
    // must surface the actual error, not the misleading 'no terminal envelope' text
    const spawnMock = () => {
      const p = new MockProc();
      p.fail(new Error('spawn docker ENOENT'));
      p.close(null, null);
      return p;
    };
    const runner = createDockerRunner({ spawn: spawnMock });
    const outcome = await runner.run(task({ image: 'tool', envelope: true }), 'run-1', new Date());
    expect(outcome.status).toBe('failed');
    expect((outcome as { error: string }).error).toContain('ENOENT');
  });
});
