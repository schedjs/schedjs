import { Client } from 'ssh2';
import { matchesPattern, isSubsetOf, taskAllowedTools } from '../allowlist.js';
import type { RunOutcome, Runner, RunnerRunHooks } from '../engine.js';
import type { TaskRecord } from '../types.js';
import { ringBuffer } from './exec.js';

/** Runner-specific config carried in `TaskRecord.config` (runner: 'ssh'). */
export interface SshRunnerConfig {
  /** Required. Remote host. */
  host: string;
  /** Default: 22. */
  port?: number;
  /** Required. Remote user. */
  username: string;
  /** Required. The remote shell command (POSIX sh on the far side). */
  command: string;
  /**
   * Credentials by env-var reference — never inline secrets in tasks.json
   * (it's the desired state in git). Exactly one of the two sources.
   */
  auth:
    | { keyFromEnv: string; passwordFromEnv?: never }
    | { passwordFromEnv: string; keyFromEnv?: never };
  /**
   * Host-key pins — `SHA256:<base64>` (ssh-keyscan format), bare base64, or
   * hex. A host whose key is not pinned fails the run. Omitted/empty = accept
   * any host key (convenience for trusted networks; not for prod).
   */
  fingerprints?: string[];
  /** Connection/command timeout — aborted after this → cancelled. Default: 5 min. */
  timeoutMs?: number;
  /** Ring-buffer log cap in KB. Default: 10. */
  maxLogKb?: number;
  /**
   * Sandbox (per-task): commands this task may run on the remote host, exact
   * or trailing-`*` (`['backup.sh', 'df*']`). The first token of
   * `config.command` is the tool. Must be a subset of the runner ceiling.
   */
  allowedTools?: string[];
}

export interface SshConnectionConfig {
  host: string;
  port: number;
  username: string;
}

export interface SshConnectionAuth {
  privateKey?: string;
  password?: string;
}

/** The transport seam — injectable for tests (docker `spawn` pattern). */
export interface SshTransport {
  /** Run a remote command; hooks stream stdout/stderr as they arrive. Resolves when the channel closes. */
  exec(
    command: string,
    hooks: { onStdout(chunk: string): void; onStderr(chunk: string): void },
  ): Promise<{ code: number | null; signal: string | null }>;
  /** Abort an in-flight command (timeout path) — closes the connection. */
  kill(): void;
  /** Dispose the connection. */
  close(): void;
}

export type SshTransportFactory = (
  config: SshConnectionConfig,
  auth: SshConnectionAuth,
  fingerprints: string[] | undefined,
) => SshTransport;

export interface SshRunnerOptions {
  /** Injectable transport factory for tests. Default: ssh2-based. */
  transport?: SshTransportFactory;
  /** Default timeout. Default: 5 min. */
  timeoutMs?: number;
  /** Default log ring-buffer cap in KB. Default: 10. */
  maxLogKb?: number;
  /**
   * Runner ceiling: commands this runner may ever run on remote hosts (exact
   * or trailing-`*`). A task whose `config.allowedTools` is not a subset fails
   * at load. Empty/omitted = allow all. Fail-fast: no connection is opened
   * for a non-allowlisted command.
   */
  allowedTools?: string[];
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_LOG_KB = 10;
const ERROR_LOG_TAIL = 4 * 1024;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Host-key fingerprint match against pinned `SHA256:<base64>` / base64 / hex
 * forms (ssh2's hostVerifier reports the SHA256 digest as hex). No pins =
 * accept (trust-unpinned is documented as a convenience, not for prod).
 */
export function fingerprintMatches(keyHash: string | Buffer, pins: string[] | undefined): boolean {
  if (!pins || pins.length === 0) return true;
  // ssh2 passes a raw host-key Buffer when cfg.hostHash is unset; hex-digest it
  // so PIN comparison works regardless (see f&f r3: keyHash.replace crash).
  const hexKey = Buffer.isBuffer(keyHash) ? keyHash.toString('hex') : keyHash;
  const hash = hexKey.replace(/^SHA256:/i, '');
  const hexFromB64 = (b64: string): string => Buffer.from(b64, 'base64').toString('hex');
  return pins.some((pin) => {
    const p = pin.replace(/^SHA256:/i, '');
    return hash === p || hash === hexFromB64(p);
  });
}

/**
 * Mismatch error that names the pins and the received fingerprint (r6 F3) —
 * ssh2's raw `Host denied (verification failed)` hides which pin is bad.
 */
export function hostKeyMismatchError(fingerprints: string[] | undefined, received: string): Error {
  return new Error(
    `Host key verification failed: received ${received}, expected one of [${(fingerprints ?? []).join(', ')}]`,
  );
}

/**
 * Host-key verifier that reports the received fingerprint on rejection, so the
 * transport can surface a mismatch error that names pins (r6 F3).
 */
export function makeHostKeyVerifier(
  fingerprints: string[] | undefined,
  onReject: (received: string) => void,
): (fp: string) => boolean {
  return (fp) => {
    const ok = fingerprintMatches(fp, fingerprints);
    if (!ok) onReject(fp);
    return ok;
  };
}

/** Load-time shape check; returns an error string or null. Env vars must exist at load (fail-fast). */
function configError(cfg: Partial<SshRunnerConfig>): string | null {
  if (!isNonEmptyString(cfg.host)) return 'missing config.host';
  if (!isNonEmptyString(cfg.username)) return 'missing config.username';
  if (!isNonEmptyString(cfg.command)) return 'missing config.command';
  const auth = cfg.auth as { keyFromEnv?: string; passwordFromEnv?: string } | undefined;
  if (!auth || (!auth.keyFromEnv && !auth.passwordFromEnv)) {
    return 'missing config.auth (exactly one of keyFromEnv | passwordFromEnv)';
  }
  if (auth.keyFromEnv && auth.passwordFromEnv) {
    return 'config.auth must have exactly one of keyFromEnv | passwordFromEnv';
  }
  if (auth.keyFromEnv && !process.env[auth.keyFromEnv]) {
    return `auth key env '${auth.keyFromEnv}' not set`;
  }
  if (auth.passwordFromEnv && !process.env[auth.passwordFromEnv]) {
    return `auth password env '${auth.passwordFromEnv}' not set`;
  }
  return null;
}

/** Fingerprint format check (load-time only). */
function fingerprintError(fingerprints: string[] | undefined): string | null {
  if (!fingerprints || fingerprints.length === 0) return null;
  for (const f of fingerprints) {
    const b64 = f.replace(/^SHA256:/i, '');
    const isB64 = /^[A-Za-z0-9+/]+={0,2}$/.test(b64);
    const isHex = /^[0-9a-fA-F]+$/.test(f);
    if (!isB64 && !isHex) return `invalid fingerprint '${f}' (expected SHA256:<base64>, base64 or hex)`;
  }
  return null;
}

/** Default transport: ssh2 Client per run, host keys verified against pins. */
function defaultTransportFactory(
  cfg: SshConnectionConfig,
  auth: SshConnectionAuth,
  fingerprints: string[] | undefined,
): SshTransport {
  const conn = new Client();
  let rejectedFp: string | null = null;
  return {
    exec(command, hooks) {
      return new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        let settled = false;
        const ok = (v: { code: number | null; signal: string | null }): void => {
          if (!settled) {
            settled = true;
            resolve(v);
          }
        };
        const fail = (e: Error): void => {
          if (!settled) {
            settled = true;
            reject(e);
          }
        };
        conn.on('error', (err) => {
          // r6 F3: a rejected host key surfaces as a bare ssh2 error — name the pins instead.
          if (rejectedFp !== null) {
            fail(hostKeyMismatchError(fingerprints, rejectedFp));
            return;
          }
          fail(err instanceof Error ? err : new Error(String(err)));
        });
        conn.on('ready', () => {
          conn.exec(command, (err, stream) => {
            if (err) {
              fail(err);
              return;
            }
            stream.on('data', (d: Buffer | string) => hooks.onStdout(d.toString()));
            stream.stderr.on('data', (d: Buffer | string) => hooks.onStderr(d.toString()));
            stream.on('close', (code: number | null, signal: string | null) => ok({ code, signal }));
          });
        });
        conn.connect({
          host: cfg.host,
          port: cfg.port,
          username: cfg.username,
          ...(auth.privateKey ? { privateKey: auth.privateKey } : {}),
          ...(auth.password ? { password: auth.password } : {}),
          // ask ssh2 to digest the host key to hex (it only does when hostHash
          // is set) so the verifier gets a string that matches `ssh-keygen -lf`
          hostHash: 'sha256',
          // sync verifier: accept only when the host key fingerprint is pinned
          hostVerifier: makeHostKeyVerifier(fingerprints, (fp) => {
            rejectedFp = fp;
          }),
          readyTimeout: 15_000,
        });
      });
    },
    kill() {
      conn.end();
    },
    close() {
      conn.end();
    },
  };
}

/**
 * SSH runner: executes a remote command per run over an SSH connection
 * (`ssh2`). Sync by design — the engine awaits the command; long commands are
 * bounded by `timeoutMs` (connection aborted → cancelled).
 *
 * - exit `0` → succeeded (stdout+stderr captured into the run log)
 * - `!=0` → failed `exit N: <tail>`
 * - timeout → `kill()` → cancelled
 * - connect/exec error (unreachable, bad auth, fingerprint mismatch) → failed
 *
 * Secrets never live in tasks.json: `auth` references env vars (`keyFromEnv` /
 * `passwordFromEnv`), resolved at run time and checked at load time.
 * Host keys: pin `fingerprints` (fail the run on mismatch) — the ssh2 default
 * of trusting any host is deliberately overridden.
 */
export function createSshRunner(options: SshRunnerOptions = {}): Runner {
  const factory = options.transport ?? defaultTransportFactory;
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const defaultMaxLogKb = options.maxLogKb ?? DEFAULT_MAX_LOG_KB;
  const ceiling = options.allowedTools;

  /** First token of the remote command — the ssh tool (argv[0] of the shell line). */
  function toolOf(command: string): string {
    return command.trim().split(/\s+/)[0] ?? command;
  }

  /** Per-task allowedTools; throws a runner-scoped config error when malformed. */
  function taskTools(cfg: Partial<SshRunnerConfig>, taskName: string): string[] | undefined {
    return taskAllowedTools(cfg, 'ssh', taskName);
  }

  return {
    validateConfig(task: { name: string; config?: unknown }): void {
      const cfg = task.config as Partial<SshRunnerConfig>;
      // policy first (admin's order): task allowedTools shape + ceiling subset,
      // then runner-specific shape (host/user/command/auth/fingerprints).
      const tools = taskTools(cfg, task.name);
      if (tools && !isSubsetOf(tools, ceiling)) {
        throw new Error(
          `ssh runner: task "${task.name}": config.allowedTools ${JSON.stringify(tools)} not a subset of runner allowedTools ${JSON.stringify(ceiling)}`,
        );
      }
      const err = configError(cfg);
      if (err) throw new Error(`ssh runner: task "${task.name}" ${err}`);
      // ceiling fail-fast at load (parity with process/docker/mcp): the actual
      // command's first token must pass the runner ceiling even without a
      // per-task allowedTools declaration.
      if (ceiling && ceiling.length > 0 && !matchesPattern(toolOf(cfg.command!), ceiling)) {
        throw new Error(
          `ssh runner: task "${task.name}": command '${toolOf(cfg.command!)}' not in runner allowedTools ${JSON.stringify(ceiling)}`,
        );
      }
      const ferr = fingerprintError(cfg.fingerprints);
      if (ferr) throw new Error(`ssh runner: task "${task.name}": ${ferr}`);
    },

    async run(task: TaskRecord, runId: string, _at?: Date, hooks?: RunnerRunHooks): Promise<RunOutcome> {
      const cfg = task.config as Partial<SshRunnerConfig>;
      const err = configError(cfg);
      if (err) return { status: 'failed', error: `ssh runner: ${err}` };

      // fail-fast before connecting: the actual tool must pass the task's own
      // allowedTools AND the runner ceiling.
      const tool = toolOf(cfg.command!);
      let tools: string[] | undefined;
      try {
        tools = taskTools(cfg, task.name);
      } catch (e) {
        return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
      }
      if (!matchesPattern(tool, tools)) {
        return { status: 'failed', error: `ssh runner: command '${tool}' not in config.allowedTools` };
      }
      if (!matchesPattern(tool, ceiling)) {
        return { status: 'failed', error: `ssh runner: command '${tool}' not in runner allowedTools` };
      }

      const auth = cfg.auth as { keyFromEnv?: string; passwordFromEnv?: string };
      // configError already guaranteed the env vars exist at this point
      const connectionAuth: SshConnectionAuth = auth.keyFromEnv
        ? { privateKey: process.env[auth.keyFromEnv]! }
        : { password: process.env[auth.passwordFromEnv!]! };

      const timeoutMs = cfg.timeoutMs ?? defaultTimeoutMs;
      const maxChars = (cfg.maxLogKb ?? defaultMaxLogKb) * 1024;
      const log = ringBuffer(maxChars);

      let transport: SshTransport;
      try {
        transport = factory(
          { host: cfg.host!, port: cfg.port ?? 22, username: cfg.username! },
          connectionAuth,
          cfg.fingerprints,
        );
      } catch (connectErr) {
        return { status: 'failed', error: connectErr instanceof Error ? connectErr.message : String(connectErr) };
      }

      const execPromise = (async (): Promise<
        { kind: 'exec'; code: number | null; signal: string | null } | { kind: 'error'; error: string }
      > => {
        try {
          const r = await transport.exec(cfg.command!, {
            onStdout: (c) => log.append(c),
            onStderr: (c) => log.append(c),
          });
          return { kind: 'exec', code: r.code, signal: r.signal };
        } catch (execErr) {
          return { kind: 'error', error: execErr instanceof Error ? execErr.message : String(execErr) };
        }
      })();

      let timer: NodeJS.Timeout;
      const timeoutPromise = new Promise<{ kind: 'timeout' }>((r) => {
        timer = setTimeout(() => r({ kind: 'timeout' }), timeoutMs);
      });
      // User-cancel: kill the hanging command and finish cancelled (same as a
      // timeout, but distinguishable — hooks.signal fires only on cancel).
      let cancelNow!: () => void;
      const cancelPromise = new Promise<{ kind: 'cancelled' }>((r) => {
        cancelNow = () => r({ kind: 'cancelled' });
      });
      const signal = hooks?.signal;
      if (signal) {
        if (signal.aborted) cancelNow();
        else signal.addEventListener('abort', cancelNow, { once: true });
      }
      const res = await Promise.race([execPromise, timeoutPromise, cancelPromise]);
      clearTimeout(timer!);

      if (res.kind === 'cancelled') {
        transport.kill(); // abort the hanging command — best effort, connection dies
        transport.close();
        return { status: 'cancelled', error: 'cancelled by user', log: log.value };
      }

      if (res.kind === 'timeout') {
        transport.kill(); // abort the hanging command — best effort, connection dies
        transport.close();
        return { status: 'cancelled', error: `timeout after ${timeoutMs}ms`, log: log.value };
      }

      transport.close();

      if (res.kind === 'error') {
        return { status: 'failed', error: res.error, log: log.value };
      }
      if (res.code === 0) {
        return { status: 'succeeded', log: log.value };
      }
      if (res.signal) {
        return { status: 'failed', error: `command killed (${res.signal})`, log: log.value };
      }
      return { status: 'failed', error: `exit ${res.code}: ${log.value.slice(-ERROR_LOG_TAIL)}`, log: log.value };
    },
  };
}
