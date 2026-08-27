/**
 * Shared exec machinery for sync command runners (docker, process, ssh).
 *
 * A sync runner spawns something, captures stdout+stderr into a ring-buffered
 * log, enforces a timeout (SIGTERM → SIGKILL grace) and maps the termination
 * to a RunOutcome. That lifecycle is identical for docker (`docker run`),
 * process (local argv) and — later — ssh (`ssh2 exec`). This module owns the
 * lifecycle; each runner owns its args-building and its outcome mapping.
 *
 * The spawn seam is injectable (`SpawnFn`) so runners are testable without a
 * real docker daemon / subprocess / ssh server — the docker runner's pattern.
 */

/** Minimal process surface a runner needs (child_process.ChildProcess-compatible). */
export interface SpawnedProcess {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  /** Present when the runner wants to write to the child (stdio contract). */
  stdin?: NodeJS.WritableStream | null;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal: NodeJS.Signals): void;
}

export interface SpawnOptions {
  env?: Record<string, string>;
  cwd?: string;
}

/** Injectable spawn. docker ignores options (env travels as `-e` CLI args); process uses them. */
export type SpawnFn = (args: string[], options?: SpawnOptions) => SpawnedProcess;

/** Sliding-window string buffer keeping the last `maxChars` characters. */
export interface RingBuffer {
  append(s: string): void;
  readonly value: string;
  tail(n: number): string;
}

export function ringBuffer(maxChars: number): RingBuffer {
  let buf = '';
  return {
    append(s: string) {
      if (s) buf = (buf + s).slice(-maxChars);
    },
    get value() {
      return buf;
    },
    tail(n: number) {
      return buf.slice(-n);
    },
  };
}

const camelToSnakeUpper = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();

function scalarString(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' || typeof v === 'string') return String(v);
  return JSON.stringify(v);
}

/**
 * camelCase data → SCREAMING_SNAKE env vars + full payload as SCHED_DATA.
 * Throws when two distinct data keys map to the same env name (fooBar vs foo_bar → FOO_BAR),
 * so the collision fails fast instead of silently last-write-wins.
 */
export function envFromData(data: unknown): Record<string, string> {
  const env: Record<string, string> = { SCHED_DATA: JSON.stringify(data) };
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const seen = new Map<string, string>(); // env name → original data key
    for (const [k, v] of Object.entries(data)) {
      const name = camelToSnakeUpper(k);
      const prior = seen.get(name);
      if (prior !== undefined) {
        throw new Error(`env collision: data keys '${prior}' and '${k}' both map to '${name}'`);
      }
      seen.set(name, k);
      env[name] = scalarString(v);
    }
  }
  return env;
}

/** Run-metadata env every sync runner sets: idempotency handle + task identity. */
export function metadataEnv(runId: string, taskName: string): Record<string, string> {
  return { SCHED_RUN_ID: runId, SCHED_TASK_NAME: taskName };
}

export interface CommandRunOptions {
  spawn: SpawnFn;
  args: string[];
  timeoutMs: number;
  maxLogKb: number;
  /** Payload written to the child's stdin after spawn; stdin is then ended (EOF). */
  stdinPayload?: string;
  /** stdout sink — default: append to the ring-buffered log. */
  onStdout?: (chunk: string, log: RingBuffer) => void;
  /** stderr sink — default: append to the ring-buffered log. */
  onStderr?: (chunk: string, log: RingBuffer) => void;
  /**
   * User-cancel signal (run cancellation): on abort the child is killed
   * (SIGTERM → SIGKILL after the same grace as a timeout) and the result is
   * marked `aborted: true` so the runner can map it to a cancelled outcome.
   */
  signal?: AbortSignal;
}

export interface CommandRunResult {
  /** Ring-buffered stdout+stderr (or whatever the sinks appended). */
  log: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError: Error | null;
  killedByTimeout: boolean;
  /** User-cancel: `signal` fired → the child was killed by cancel, not timeout. */
  aborted: boolean;
}

const KILL_GRACE_MS = 10_000;

/**
 * Spawn → stream → timeout (SIGTERM → SIGKILL) → close. Pure lifecycle: no
 * outcome semantics — the caller maps `CommandRunResult` to a RunOutcome.
 */
export function runCommand(opts: CommandRunOptions): Promise<CommandRunResult> {
  const log = ringBuffer(opts.maxLogKb * 1024);
  const onStdout = opts.onStdout ?? ((chunk: string, l: RingBuffer) => l.append(chunk));
  const onStderr = opts.onStderr ?? ((chunk: string, l: RingBuffer) => l.append(chunk));

  let proc: SpawnedProcess;
  try {
    proc = opts.spawn(opts.args);
  } catch (err) {
    return Promise.resolve({
      log: log.value,
      code: null,
      signal: null,
      spawnError: err instanceof Error ? err : new Error(String(err)),
      killedByTimeout: false,
      aborted: false,
    });
  }

  return new Promise<CommandRunResult>((resolve) => {
    let settled = false;
    let spawnError: Error | null = null;
    let killedByTimeout = false;
    let aborted = false;
    let sigkillTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const finish = (result: CommandRunResult): void => {
      if (settled) return;
      settled = true;
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };

    // User-cancel: SIGTERM now, SIGKILL after the grace period (same as a
    // timeout). Once settled the listener is inert — finish() already resolved.
    const onCancel = (): void => {
      if (settled) return;
      aborted = true;
      proc.kill('SIGTERM');
      sigkillTimer = setTimeout(() => {
        if (!settled) proc.kill('SIGKILL');
      }, KILL_GRACE_MS);
    };
    if (opts.signal) {
      if (opts.signal.aborted) onCancel();
      else opts.signal.addEventListener('abort', onCancel, { once: true });
    }

    proc.stdout?.on('data', (c: string | Buffer) => onStdout(c.toString(), log));
    proc.stderr?.on('data', (c: string | Buffer) => onStderr(c.toString(), log));

    proc.on('error', (err) => {
      spawnError = err;
    });

    proc.on('close', (code, signal) => {
      finish({ log: log.value, code, signal, spawnError, killedByTimeout, aborted });
    });

    if (opts.stdinPayload !== undefined && proc.stdin) {
      proc.stdin.write(opts.stdinPayload);
      proc.stdin.end();
    }

    // Prod defect 3 (books post-cutover 2026-08-22): `timeoutMs: -1` means "no
    // container timeout" — a negative value must never arm the kill timer
    // (setTimeout(-1) fires immediately → instant SIGTERM → "timeout after -1ms").
    // `0` is reserved for the same no-timeout semantics (explicit off).
    if (opts.timeoutMs > 0) {
      killTimer = setTimeout(() => {
        killedByTimeout = true;
        proc.kill('SIGTERM');
        sigkillTimer = setTimeout(() => {
          if (!settled) proc.kill('SIGKILL');
        }, KILL_GRACE_MS);
      }, opts.timeoutMs);
    }
  });
}
