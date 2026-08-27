import { spawn as nodeSpawn } from 'node:child_process';
import { dockerToolAllowed, isSubsetOf, taskAllowedTools } from '../allowlist.js';
import type { RunOutcome, Runner, RunnerRunHooks } from '../engine.js';
import type { TaskRecord } from '../types.js';
import { EnvelopeParser, outcomeFromEnvelope, requestEnvelope } from './envelope.js';
import { envFromData, ringBuffer, runCommand } from './exec.js';
import type { RingBuffer, SpawnedProcess, SpawnFn } from './exec.js';

export { ringBuffer } from './exec.js';
export type { SpawnedProcess } from './exec.js';

/** Runner-specific config carried in `TaskRecord.config` (runner: 'docker'). */
export interface DockerRunnerConfig {
  /** Required. e.g. 'registry.example.com/books-tool'. */
  image: string;
  /** Default: 'latest'. */
  tag?: string;
  /** Entrypoint override (`--entrypoint`). */
  command?: string[];
  /** Container args appended after the image. */
  args?: string[];
  /**
   * Docker network to join (`docker run --network <name>`). Default: bridge.
   * Set e.g. `proxy` when the tool must reach sibling services by container
   * name (books-web:3000, chrome:3000) — the default bridge cannot resolve
   * names from other networks.
   */
  network?: string;
  /** Static per-task env (contract). Merged over data-derived vars. */
  env?: Record<string, string>;
  /**
   * Run parameters. camelCase keys → SCREAMING_SNAKE env vars
   * (ID_PICKING_LIST=42, DRY_RUN=false), the whole payload as `SCHED_DATA`.
   */
  data?: unknown;
  /** Container timeout — killed after this (SIGTERM → SIGKILL). Default: 5 min. */
  timeoutMs?: number;
  /** Ring-buffer log cap in KB. Default: 10. */
  maxLogKb?: number;
  /**
   * Stdio contract (opt-in): the request envelope `{ task, data }` is written
   * to the container's **stdin** (`-i`), the worker answers with NDJSON
   * envelopes on **stdout** (intermediate `running`/terminal), and **stderr**
   * stays free for logs. Off (default) → exit-code mapping — a container that
   * doesn't speak the protocol keeps working unchanged. See `05.protocol.md`.
   */
  envelope?: boolean;
  /**
   * Sandbox (per-task): tools this task may run, `image` or `image@command`
   * specs (`['alpine', 'registry.example.com/*@echo']`). Must be a subset of
   * the runner ceiling. Omitted → allow all (ceiling still applies at run).
   */
  allowedTools?: string[];
}

export interface DockerRunnerOptions {
  /** Injectable spawn for tests. Default: `child_process.spawn('docker', args)`. */
  spawn?: SpawnFn;
  /** Default container timeout. Default: 5 min. */
  timeoutMs?: number;
  /** Default log ring-buffer cap in KB. Default: 10. */
  maxLogKb?: number;
  /**
   * Runner ceiling: docker tools this runner may ever run — `image` or
   * `image@command` specs (exact or trailing-`*` on either side). A task whose
   * `config.allowedTools` is not a subset fails at load. Empty/omitted = allow
   * all. Fail-fast: a non-allowlisted image/command never reaches the daemon.
   */
  allowedTools?: string[];
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_LOG_KB = 10;
const ERROR_LOG_TAIL = 4 * 1024;

/** Resolve the effective image (default tag :latest, explicit cfg.tag wins). */
function resolveImage(cfg: Partial<DockerRunnerConfig>): string | null {
  if (!isNonEmptyString(cfg.image)) return null;
  const hasTag = /:[^/]+$/.test(cfg.image);
  return cfg.tag ? `${cfg.image}:${cfg.tag}` : hasTag ? cfg.image : `${cfg.image}:latest`;
}

/**
 * Docker runner (port of books Phase 5): spawns a one-shot container per run,
 * captures stdout+stderr into a ring-buffered log, maps the exit code to the
 * run status and removes the container (`--rm`) regardless of the outcome.
 *
 * - `0` → succeeded (log attached)
 * - `!=0` → failed `exit N: <tail>` (books mapping)
 * - timeout → killed (SIGTERM, SIGKILL after grace) → cancelled
 * - spawn error (docker missing / daemon down) → failed
 *
 * Metadata env: `SCHED_RUN_ID` (idempotency handle for the worker), `SCHED_TASK_NAME`,
 * plus data-derived `SCREAMING_SNAKE` vars and the full `SCHED_DATA` JSON.
 *
 * Security: run the daemon behind a docker-socket-proxy (read-only surface) and
 * gate images with an allowlist — see the `runner-auth` track. This runner talks
 * to the local docker CLI; `DOCKER_HOST` env routes it through the proxy.
 *
 * Sync by design (the engine awaits the container); long-running containers are
 * bounded by `timeoutMs`. A counting semaphore like books' `maxConcurrent` is
 * unnecessary in v1 — the engine executes runs sequentially.
 *
 * The lifecycle (spawn → ring-buffer → timeout → close) lives in
 * `./exec.ts` (`runCommand`) — shared with the process runner.
 */
export function createDockerRunner(options: DockerRunnerOptions = {}): Runner {
  const spawnImpl = options.spawn ?? ((args: string[]) => nodeSpawn('docker', args));
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const defaultMaxLogKb = options.maxLogKb ?? DEFAULT_MAX_LOG_KB;
  const ceiling = options.allowedTools;

  /** Per-task allowedTools; throws a runner-scoped config error when malformed. */
  function taskTools(cfg: Partial<DockerRunnerConfig>, taskName: string): string[] | undefined {
    return taskAllowedTools(cfg, 'docker', taskName);
  }

  /** The explicit entrypoint (image@command second dimension), if the task overrides it. */
  function explicitCommand(cfg: Partial<DockerRunnerConfig>): string | undefined {
    return cfg.command && cfg.command.length > 0 && cfg.command[0] ? cfg.command[0] : undefined;
  }

  return {
    validateConfig(task: { name: string; config?: unknown }): void {
      const cfg = task.config as Partial<DockerRunnerConfig>;
      // policy first (admin's order): task allowedTools shape + ceiling subset,
      // then runner-specific shape (image presence, image/command ceiling, env).
      const tools = taskTools(cfg, task.name);
      if (tools && !isSubsetOf(tools, ceiling)) {
        throw new Error(
          `docker runner: task "${task.name}": config.allowedTools ${JSON.stringify(tools)} not a subset of runner allowedTools ${JSON.stringify(ceiling)}`,
        );
      }
      if (!isNonEmptyString(cfg.image)) {
        throw new Error(`docker runner: task "${task.name}" missing config.image`);
      }
      const image = resolveImage(cfg);
      if (image !== null && !dockerToolAllowed(image, explicitCommand(cfg), ceiling)) {
        throw new Error(`docker runner: task "${task.name}": image/command '${image}${explicitCommand(cfg) ? '@' + explicitCommand(cfg) : ''}' not in runner allowedTools`);
      }
      if (cfg.data !== undefined) envFromData(cfg.data); // fail-fast on env collisions at load time
      if (cfg.network !== undefined && !isNonEmptyString(cfg.network)) {
        throw new Error(`docker runner: task "${task.name}": config.network must be a non-empty string`);
      }
      // Prod defect 3: `timeoutMs: -1` = no container timeout (explicit off),
      // `> 0` = SIGTERM → SIGKILL deadline. Anything else (0, -2, NaN, string)
      // fails fast at load — mirror the task-level run-deadline contract.
      if (
        cfg.timeoutMs !== undefined &&
        (typeof cfg.timeoutMs !== 'number' || !Number.isFinite(cfg.timeoutMs) || (cfg.timeoutMs !== -1 && cfg.timeoutMs <= 0))
      ) {
        throw new Error(`docker runner: task "${task.name}": config.timeoutMs must be -1 (no timeout) or a positive number of milliseconds`);
      }
    },
    async run(task: TaskRecord, runId: string, _startedAt?: Date, hooks?: RunnerRunHooks): Promise<RunOutcome> {
      const cfg = task.config as Partial<DockerRunnerConfig>;
      if (!isNonEmptyString(cfg.image)) return { status: 'failed', error: 'docker runner: missing config.image' };

      const image = resolveImage(cfg);
      if (image === null) return { status: 'failed', error: 'docker runner: missing config.image' };
      const command = explicitCommand(cfg);

      // fail-fast before spawn: the actual tool must pass the task's own
      // allowedTools AND the runner ceiling.
      let tools: string[] | undefined;
      try {
        tools = taskTools(cfg, task.name);
      } catch (err) {
        return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
      }
      if (!dockerToolAllowed(image, command, tools)) {
        return { status: 'failed', error: `docker runner: tool '${image}${command ? '@' + command : ''}' not in config.allowedTools` };
      }
      if (!dockerToolAllowed(image, command, ceiling)) {
        return { status: 'failed', error: `docker runner: tool '${image}${command ? '@' + command : ''}' not in runner allowedTools` };
      }
      const timeoutMs = cfg.timeoutMs ?? defaultTimeoutMs;

      const args = [
        'run', '--rm', '--name', `sched-${runId}`,
        ...(cfg.network ? ['--network', cfg.network] : []),
        ...(cfg.envelope ? ['-i'] : []), // attach stdin for the stdio contract
        '-e', `SCHED_RUN_ID=${runId}`,
        '-e', `SCHED_TASK_NAME=${task.name}`,
      ];
      // static env (task contract) wins over data-derived vars — same merge as books
      let mergedEnv: Record<string, string>;
      try {
        mergedEnv = { ...(cfg.data !== undefined ? envFromData(cfg.data) : {}), ...(cfg.env ?? {}) };
      } catch (err) {
        // env collision slipped past validateConfig — fail the run, never spawn with a silent overwrite
        return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
      }
      for (const [k, v] of Object.entries(mergedEnv)) args.push('-e', `${k}=${v}`);
      const postImageArgs: string[] = [];
      if (cfg.command?.length) {
        const [entry, ...rest] = cfg.command;
        if (entry) args.push('--entrypoint', entry);
        postImageArgs.push(...rest); // command[1..] are argv for the entrypoint, not docker flags
      }
      args.push(image);
      args.push(...postImageArgs); // command[1..] — primary argv for the entrypoint
      if (cfg.args) args.push(...cfg.args); // extra args appended

      const parser = new EnvelopeParser(hooks?.onProgress ? { onRunning: hooks.onProgress } : undefined);
      const result = await runCommand({
        spawn: spawnImpl,
        args,
        timeoutMs,
        maxLogKb: cfg.maxLogKb ?? defaultMaxLogKb,
        ...(hooks?.signal ? { signal: hooks.signal } : {}),
        ...(cfg.envelope
          ? {
              stdinPayload: requestEnvelope(task, ['envelope']) + '\n',
              onStdout: (chunk: string) => void parser.feed(chunk),
              onStderr: (chunk: string, log: RingBuffer) => log.append(chunk),
            }
          : {}),
      });

      if (result.spawnError) {
        return { status: 'failed', error: result.spawnError.message, log: result.log };
      }

      if (cfg.envelope) {
        // Protocol violation (parser recorded it) surfaces as a failed run, not a crash
        // (spawnError is handled above — a daemon-down must not masquerade as a
        // protocol violation, mirroring process.ts).
        if (parser.violation) {
          return { status: 'failed', error: `docker runner: ${parser.violation}`, log: result.log };
        }
        if (parser.terminal) {
          const outcome = outcomeFromEnvelope(parser.terminal);
          // intermediate `running` envelopes feed progress/log when the terminal lacks them
          if (outcome.progress === undefined && parser.lastProgress !== null) outcome.progress = parser.lastProgress;
          if (outcome.log === undefined && parser.lastLog !== null) outcome.log = parser.lastLog;
          if (result.log) outcome.log = (outcome.log ?? '') + result.log; // stderr stays free
          return outcome;
        }
        return {
          status: 'failed',
          error: `docker runner: container exited without a terminal envelope (protocol violation)`,
          log: result.log,
        };
      }

      if (result.aborted) {
        return { status: 'cancelled', error: 'cancelled by user', log: result.log };
      }
      if (result.killedByTimeout) {
        return { status: 'cancelled', error: `timeout after ${timeoutMs}ms`, log: result.log };
      }
      if (result.signal) {
        return { status: 'failed', error: `container killed (${result.signal})`, log: result.log };
      }
      if (result.code === 0) {
        return { status: 'succeeded', log: result.log };
      }
      return { status: 'failed', error: `exit ${result.code}: ${result.log.slice(-ERROR_LOG_TAIL)}`, log: result.log };
    },
  };
}
