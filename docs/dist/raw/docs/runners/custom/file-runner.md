# File runner

> A complete file-drop runner — the reference implementation for the build-your-own runner story

The complete reference — a **file-drop** runner: `run()` drops a job file into a directory,
any process (in any language) picks it up and writes back a result file. Zero dependencies —
filesystem only, so it runs anywhere. The same code lives in
`packages/core/test/helpers/file-runner.ts`:

```ts
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunOutcome, Runner, RunnerRunHooks } from '../../src/engine.js';
import type { TaskRecord } from '../../src/types.js';

export interface FileRunnerOptions {
  /** Inbox directory where job files are dropped. Config `dir` wins over this. Default: cwd. */
  dir?: string;
  /** Filesystem poll interval. Default: 250ms. */
  pollMs?: number;
  /** How long `run` waits for the result file before failing. Default: 30s. */
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * File-drop runner: reference implementation for the "Custom runners" docs page.
 *
 * `run()` drops `<dir>/job-<runId>.json` (task config + runId + startedAt — any
 * process, any language can pick it up), then polls the filesystem until a
 * worker writes `<dir>/<runId>.result.json` (terminal outcome) or the timeout
 * fires. Workers report live progress by writing `<dir>/<runId>.progress.json`
 * with a `progress` number — the runner forwards it via `hooks.onProgress`.
 *
 * Cancellation: on `signal.abort` the runner deletes the job file and rejects
 * with an `AbortError` (the engine maps it to a `cancelled` run). No external
 * dependencies — filesystem only, so it runs anywhere and tests on tmp dirs.
 */
export function createFileRunner(options: FileRunnerOptions = {}): Runner {
  const resolveDir = (task: { name: string; config?: unknown }): string => {
    const cfg = (task.config ?? {}) as { dir?: string };
    const dir = cfg.dir ?? options.dir ?? process.cwd();
    if (!existsSync(dir)) throw new Error(`file runner: dir "${dir}" does not exist (task "${task.name}")`);
    return dir;
  };

  return {
    validateConfig(task) {
      resolveDir(task); // throws → daemon aborts startup with a clear error
    },

    async run(task: TaskRecord, runId: string, startedAt: Date, hooks?: RunnerRunHooks): Promise<RunOutcome> {
      const dir = resolveDir(task);
      if (hooks?.signal?.aborted) {
        return { status: 'cancelled', error: 'aborted before dispatch' };
      }

      const jobFile = join(dir, `job-${runId}.json`);
      writeFileSync(
        jobFile,
        JSON.stringify(
          { runId, taskName: task.name, config: task.config ?? null, startedAt: startedAt.toISOString() },
          null,
          2,
        ),
      );

      const resultFile = join(dir, `${runId}.result.json`);
      const progressFile = join(dir, `${runId}.progress.json`);
      const timeoutMs = options.timeoutMs ?? 30_000;
      const pollMs = options.pollMs ?? 250;
      const deadline = Date.now() + timeoutMs;

      try {
        while (Date.now() < deadline) {
          if (hooks?.signal?.aborted) throw abortError();

          if (existsSync(progressFile)) {
            try {
              const { progress } = JSON.parse(readFileSync(progressFile, 'utf8')) as { progress?: number };
              if (typeof progress === 'number') await hooks?.onProgress?.(progress);
            } catch {
              /* malformed progress file — ignore, keep polling */
            }
            rmSync(progressFile);
          }

          if (existsSync(resultFile)) {
            let body: Record<string, unknown>;
            try {
              body = JSON.parse(readFileSync(resultFile, 'utf8')) as Record<string, unknown>;
            } catch {
              return { status: 'failed', error: `result file ${resultFile} is not valid JSON` };
            }
            rmSync(resultFile);
            if (body.status === 'succeeded') {
              return {
                status: 'succeeded',
                result: body.result,
                log: typeof body.log === 'string' ? body.log : null,
              };
            }
            return {
              status: 'failed',
              error: typeof body.error === 'string' ? body.error : 'worker reported failure',
              result: body.result,
            };
          }

          await sleep(pollMs);
        }
        return { status: 'failed', error: `file runner: no result file after ${timeoutMs}ms (${resultFile})` };
      } finally {
        if (existsSync(jobFile)) rmSync(jobFile); // cleanup: abort, timeout, or terminal result
      }
    },
  };
}

function abortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}
```
