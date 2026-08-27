/**
 * The stdio contract (shared by the process and docker runners' `envelope`
 * mode): request `{ task, data }` on stdin, NDJSON envelopes on stdout
 * (intermediate `running` with progress, then a terminal envelope), worker
 * logs on stderr (never stdout — stdout is the protocol channel).
 *
 * Parsing is shared so both runners behave identically: a worker that opted
 * into the protocol but exits without a terminal envelope is a broken worker —
 * the run fails with a clear protocol error, never silently passes.
 */

import type { RunOutcome } from '../engine.js';
import type { TaskRecord } from '../types.js';
import type { ArtifactRef } from '../types.js';

export interface Envelope {
  status?: string;
  result?: unknown;
  error?: string | null;
  progress?: number | null;
  log?: string | null;
  artifacts?: ArtifactRef[] | null;
}

export type TerminalEnvelope = Extract<Envelope, { status: 'succeeded' | 'failed' | 'cancelled' }>;

export function parseEnvelopeLine(line: string): Envelope | null {
  try {
    const body = JSON.parse(line) as Record<string, unknown>;
    return body && typeof body === 'object' && typeof body.status === 'string' ? (body as Envelope) : null;
  } catch {
    return null;
  }
}

/**
 * Line-based stdout parser for the stdio contract. Returns the terminal
 * envelope when one arrives, `null` for intermediate `running`/`queued` lines
 * (their progress/log feed the outcome). Never throws from a stream handler —
 * a protocol violation (non-JSON line, unknown status) is recorded in
 * `violation` and the runner maps it to a failed run after the process exits.
 */
export class EnvelopeParser {
  private _terminal: Envelope | null = null;
  private _violation: string | null = null;
  private lastSeenProgress: number | null = null;
  private lastSeenLog: string | null = null;
  private buffer = '';
  private readonly onRunning: ((progress: number) => void | Promise<void>) | undefined;

  constructor(opts?: { onRunning?: (progress: number) => void | Promise<void> }) {
    this.onRunning = opts?.onRunning;
  }

  /** Feed a stdout chunk; returns the terminal envelope when the worker reported it. */
  feed(chunk: string): Envelope | null {
    if (this._terminal || this._violation) return this._terminal; // already answered / already broken
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? ''; // keep the incomplete tail for the next chunk
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      const env = parseEnvelopeLine(line);
      if (env === null) {
        this._violation = `protocol violation — non-envelope line on stdout: ${line.slice(0, 120)}`;
        return this._terminal;
      }
      if (env.status === 'succeeded' || env.status === 'failed' || env.status === 'cancelled') {
        this._terminal = env;
        return this._terminal;
      }
      if (env.status === 'running' || env.status === 'queued') {
        if (env.progress !== undefined && env.progress !== null) {
          this.lastSeenProgress = env.progress;
          if (this.onRunning) void this.onRunning(env.progress);
        }
        if (env.log !== undefined && env.log !== null) this.lastSeenLog = env.log;
      } else {
        this._violation = `protocol violation — unknown envelope status '${env.status}'`;
        return this._terminal;
      }
    }
    return this._terminal;
  }

  /** Terminal progress, or the last intermediate `running` progress when the terminal lacks one. */
  get lastProgress(): number | null {
    return this._terminal?.progress ?? this.lastSeenProgress;
  }

  /** Terminal log, or the last intermediate log when the terminal lacks one. */
  get lastLog(): string | null {
    return this._terminal?.log ?? this.lastSeenLog;
  }

  /** The terminal envelope, once the worker reported one. */
  get terminal(): Envelope | null {
    return this._terminal;
  }

  /** Recorded protocol violation, or null when the stream was clean. */
  get violation(): string | null {
    return this._violation;
  }
}

export function outcomeFromEnvelope(env: Envelope): Extract<RunOutcome, { status: 'succeeded' | 'failed' | 'cancelled' }> {
  const base: { progress?: number | null; log?: string | null; artifacts?: ArtifactRef[] | null; result?: unknown } = {};
  if (env.progress !== undefined) base.progress = env.progress;
  if (env.log !== undefined) base.log = env.log;
  if (env.artifacts !== undefined) base.artifacts = env.artifacts;
  if (env.result !== undefined) base.result = env.result;
  switch (env.status) {
    case 'succeeded':
      return { status: 'succeeded', ...base };
    case 'failed':
      return { status: 'failed', error: env.error ?? 'worker reported failure', ...base };
    default:
      return { status: 'cancelled', error: env.error ?? 'worker cancelled the run', ...base };
  }
}

/**
 * The request envelope written to the child's stdin (mirrors the http-runner
 * envelope body). `stripKeys` removes sched-internal flags from the task config
 * echoed to the worker (e.g. `envelope` itself).
 */
export function requestEnvelope(task: TaskRecord, stripKeys: string[] = []): string {
  const config = task.config as Record<string, unknown>;
  const stripped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (!stripKeys.includes(k)) stripped[k] = v;
  }
  return JSON.stringify({
    task: { name: task.name, config: stripped },
    data: (task.config as { data?: unknown })?.data ?? null,
  });
}
