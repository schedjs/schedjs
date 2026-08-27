import { spawn as nodeSpawn } from 'node:child_process';
import { matchesPattern, isSubsetOf, taskAllowedTools } from '../allowlist.js';
import type { RunOutcome, Runner, RunnerRunHooks } from '../engine.js';
import type { TaskRecord } from '../types.js';
import { EnvelopeParser, outcomeFromEnvelope, requestEnvelope } from './envelope.js';
import { envFromData, metadataEnv, runCommand } from './exec.js';
import type { RingBuffer, SpawnFn } from './exec.js';

/** Runner-specific config carried in `TaskRecord.config` (runner: 'process'). */
export interface ProcessRunnerConfig {
  /**
   * Required. The full argv, no shell: `command[0]` is the executable
   * (`node`, `python3`, `powershell -File …`). Shell features (globs, pipes,
   * redirects) are not available — the interpreter is explicit by design.
   */
  command: string[];
  /** Extra argv appended after `command`. */
  args?: string[];
  /** Static per-task env (contract). Merged over data-derived vars. */
  env?: Record<string, string>;
  /**
   * Run parameters. camelCase keys → SCREAMING_SNAKE env vars
   * (ID_PICKING_LIST=42), the whole payload as `SCHED_DATA`. Same contract as
   * the docker runner.
   */
  data?: unknown;
  /**
   * Stdio contract (opt-in): the request envelope `{ task, data }` is written
   * to the child's **stdin**, the worker answers with NDJSON envelopes on
   * **stdout** (intermediate `running`/terminal `succeeded|failed|cancelled`),
   * and **stderr** stays free for worker logs (captured into the run log).
   * Off (default) → exit-code mapping, stdout+stderr both captured as log.
   */
  envelope?: boolean;
  /** Working directory for the child. Default: the daemon's cwd. */
  cwd?: string;
  /** Process timeout — killed after this (SIGTERM → SIGKILL). Default: 5 min. */
  timeoutMs?: number;
  /** Ring-buffer log cap in KB. Default: 10. */
  maxLogKb?: number;
  /**
   * Sandbox (per-task): executables this task may run, exact or trailing-`*`
   * (`['node', 'python*']`). Must be a subset of the runner ceiling. Omitted
   * → allow all (the runner ceiling still applies at run time).
   */
  allowedTools?: string[];
}

export interface ProcessRunnerOptions {
  /** Injectable spawn for tests. Default: `child_process.spawn(command[0], rest, { env, cwd })`. */
  spawn?: SpawnFn;
  /** Default process timeout. Default: 5 min. */
  timeoutMs?: number;
  /** Default log ring-buffer cap in KB. Default: 10. */
  maxLogKb?: number;
  /**
   * Runner ceiling: executables this runner may ever run (exact or trailing-`*`
   * prefixes). A task whose `config.allowedTools` is not a subset fails at load.
   * Empty/omitted = allow all. Fail-fast: a non-allowlisted command never spawns.
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
 * Process runner: executes a local command (`config.command` argv, no shell)
 * per run. Exit-code mode (default): `0` → succeeded, `!=0` → failed with log
 * tail, timeout → cancelled — the same mapping as the docker runner.
 *
 * Envelope mode (`config.envelope`): the worker speaks the stdio contract —
 * request `{ task, data }` on stdin, NDJSON envelopes on stdout (intermediate
 * `running` with progress, then a terminal `succeeded|failed|cancelled`),
 * logs on stderr. A worker that opted into the protocol but never emits a
 * terminal envelope is a broken worker — the run fails, never silently passes.
 *
 * Security: `allowedTools` sandbox — per-task `config.allowedTools` (what this
 * task may run) + runner ceiling `options.allowedTools` (what the runner may
 * ever run). Policy is checked BEFORE anything spawns, at load (fail-fast) and
 * at run; argv is explicit with no shell (no injection surface beyond what the
 * operator configures).
 */
export function createProcessRunner(options: ProcessRunnerOptions = {}): Runner {
  const defaultSpawn: SpawnFn = (args, opts) => nodeSpawn(args[0]!, args.slice(1), opts);
  const spawnImpl = options.spawn ?? defaultSpawn;
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const defaultMaxLogKb = options.maxLogKb ?? DEFAULT_MAX_LOG_KB;
  const ceiling = options.allowedTools;

  function effectiveCommand(cfg: Partial<ProcessRunnerConfig>): string[] | null {
    const cmd = cfg.command;
    if (!Array.isArray(cmd) || cmd.length === 0 || !isNonEmptyString(cmd[0])) return null;
    return cmd;
  }

  /** Per-task allowedTools; throws a runner-scoped config error when malformed. */
  function taskTools(cfg: Partial<ProcessRunnerConfig>, taskName: string): string[] | undefined {
    return taskAllowedTools(cfg, 'process', taskName);
  }

  return {
    validateConfig(task: { name: string; config?: unknown }): void {
      const cfg = task.config as Partial<ProcessRunnerConfig>;
      // policy first (admin's order): task allowedTools shape + ceiling subset,
      // then runner-specific shape (command, env collisions).
      const tools = taskTools(cfg, task.name);
      if (tools && !isSubsetOf(tools, ceiling)) {
        throw new Error(
          `process runner: task "${task.name}": config.allowedTools ${JSON.stringify(tools)} not a subset of runner allowedTools ${JSON.stringify(ceiling)}`,
        );
      }
      const cmd = effectiveCommand(cfg);
      if (!cmd) {
        throw new Error(`process runner: task "${task.name}" missing config.command`);
      }
      if (!matchesPattern(cmd[0]!, ceiling)) {
        throw new Error(`process runner: task "${task.name}": command '${cmd[0]}' not in runner allowedTools`);
      }
      if (cfg.data !== undefined) envFromData(cfg.data); // fail-fast on env collisions at load time
    },
    async run(task: TaskRecord, runId: string, _startedAt?: Date, hooks?: RunnerRunHooks): Promise<RunOutcome> {
      const cfg = task.config as Partial<ProcessRunnerConfig>;
      const cmd = effectiveCommand(cfg);
      if (!cmd) return { status: 'failed', error: 'process runner: missing config.command' };
      const exec = cmd[0]!;

      // fail-fast before spawn: the actual tool must pass the task's own
      // allowedTools AND the runner ceiling.
      let tools: string[] | undefined;
      try {
        tools = taskTools(cfg, task.name);
      } catch (err) {
        return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
      }
      if (!matchesPattern(exec, tools)) {
        return { status: 'failed', error: `process runner: command '${exec}' not in config.allowedTools` };
      }
      if (!matchesPattern(exec, ceiling)) {
        return { status: 'failed', error: `process runner: command '${exec}' not in runner allowedTools` };
      }

      const timeoutMs = cfg.timeoutMs ?? defaultTimeoutMs;
      const args = [...cmd, ...(cfg.args ?? [])];

      // static env (task contract) wins over data-derived vars — same merge as docker
      let mergedEnv: Record<string, string>;
      try {
        mergedEnv = {
          ...metadataEnv(runId, task.name),
          ...(cfg.data !== undefined ? envFromData(cfg.data) : {}),
          ...(cfg.env ?? {}),
        };
      } catch (err) {
        return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
      }

      // Envelope mode: stdout is the protocol channel, stderr stays free for logs.
      const parser = new EnvelopeParser(hooks?.onProgress ? { onRunning: hooks.onProgress } : undefined);
      const result = await runCommand({
        spawn: (args) => spawnImpl(args, { env: mergedEnv, ...(cfg.cwd ? { cwd: cfg.cwd } : {}) }),
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
        // Protocol violation (parser recorded it) surfaces as a failed run, not a crash.
        if (parser.violation) {
          return { status: 'failed', error: parser.violation, log: result.log };
        }
        if (parser.terminal) {
          const outcome = outcomeFromEnvelope(parser.terminal);
          // intermediate `running` envelopes feed progress/log when the terminal lacks them
          if (outcome.progress === undefined && parser.lastProgress !== null) outcome.progress = parser.lastProgress;
          if (outcome.log === undefined && parser.lastLog !== null) outcome.log = parser.lastLog;
          // stderr stays free in the contract — append the captured stderr log on top of the envelope's own log
          if (result.log) outcome.log = (outcome.log ?? '') + result.log;
          return outcome;
        }
        return {
          status: 'failed',
          error: `process runner: worker exited without a terminal envelope (protocol violation)`,
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
        return { status: 'failed', error: `process killed (${result.signal})`, log: result.log };
      }
      if (result.code === 0) {
        return { status: 'succeeded', log: result.log };
      }
      return { status: 'failed', error: `exit ${result.code}: ${result.log.slice(-ERROR_LOG_TAIL)}`, log: result.log };
    },
  };
}
