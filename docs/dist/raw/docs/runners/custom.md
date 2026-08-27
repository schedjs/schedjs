# Custom runners

> Write your own runner against the Runner contract

A **runner** owns *how* a task runs. The engine owns scheduling and state; the runner owns
execution — an HTTP call, a Docker container, an in-process function, anything. Built-in
runners are HTTP and Docker; this page shows how to write your own.

## The contract

A runner implements the `Runner` interface (exported from `@schedjs/core`):

```ts
interface Runner {
  run(task: TaskRecord, runId: string, startedAt: Date, hooks?: RunnerRunHooks): Promise<RunOutcome>;
  poll?(runId: string, statusUrl: string, task?: TaskRecord): Promise<PollResult>;
  validateConfig?(task: { name: string; config?: unknown }): void;
}
```

`hooks.onProgress` (the 4th argument) is how a **sync** runner reports live
progress — the engine persists it to storage before the run finishes, so a long
running task shows progress in the UI even before its final outcome.

`Runner`, `RunOutcome`, `PollResult` and `RunnerRunHooks` are all exported from
`@schedjs/core`.

- **run** is mandatory. It receives the claimed task, a unique `runId`, the start
timestamp, and optional `hooks` (`RunnerRunHooks`), and returns a `RunOutcome`.

### `hooks.signal` — user cancel

`hooks.signal` is an `AbortSignal` that fires when the operator cancels the run
(`POST /runs/:id/cancel` → `engine.cancelRun`). A runner **must** react to it:

```ts
interface RunnerRunHooks {
  onProgress?(progress: number): void | Promise<void>;
  signal?: AbortSignal;
}
```

- On `abort`, terminate the work and **reject with an Error whose name is
'AbortError'** — the engine maps it to a `cancelled` run. (Alternatively
return a `cancelled` outcome directly.)
- Built-ins: process/docker/ssh kill the child (`SIGTERM` → `SIGKILL` after the
grace period), http aborts the request, internal rejects the in-flight handler.
- The signal is optional and backward-compatible: a runner that ignores it simply
cannot be cancelled mid-flight (it stays cancellable while queued).
- **poll** is optional. You only need it if `run` can return `accepted` (async jobs —
see below). A runner that never accepts doesn't implement it.
- **validateConfig** is optional. The daemon calls it for every task at start; throwing
aborts startup with a clear error. Use it to reject a bad task config before any run
happens — the docker runner uses it to fail fast when a task's image is outside the
allowlist.

## RunOutcome — four variants

```ts
type RunOutcome =
  | { status: 'succeeded'; result?: unknown; progress?: number | null; log?: string | null; artifacts?: ArtifactRef[] | null }
  | { status: 'failed';    error: string;    result?: unknown; progress?: number | null; log?: string | null; artifacts?: ArtifactRef[] | null }
  | { status: 'cancelled'; error: string;    result?: unknown; progress?: number | null; log?: string | null; artifacts?: ArtifactRef[] | null }
  | { status: 'accepted';  statusUrl: string; pollIntervalMs: number };
```

- `succeeded` / `failed` / `cancelled` are terminal. The engine stores everything the
outcome carries on the run record via `finishRun`.
- `accepted` is for **async jobs**: the worker acknowledged the run and will expose status
at `statusUrl`. The engine marks the run `queued`, stores `workerRef = statusUrl`, and
polls `statusUrl` on its own cadence until a terminal result arrives.

### PollResult

When polling, intermediate responses keep the run alive without completing it:

```ts
type PollResult =
  | { status: 'queued' | 'running'; progress?: number | null; log?: string | null; result?: unknown }
  | { status: 'succeeded'; result?: unknown; progress?: number | null; log?: string | null; artifacts?: ArtifactRef[] | null }
  | { status: 'failed';    error: string; result?: unknown; progress?: number | null; log?: string | null; artifacts?: ArtifactRef[] | null };
```

Intermediate `queued`/`running` responses write `progress`/`log`/`result` onto the run
record without finishing it; terminal responses complete it.

## Registering a runner

Pass your implementations to `createDaemon` — a map of runner name → implementation.
The daemon dispatches per task by the task's `runner` field.

> `createDaemon` lives in **@schedjs/daemon** (not `@schedjs/core`); the runner
> factories (`createHttpRunner`, `createDockerRunner`) and the `Runner` type are
> exported from `@schedjs/core`.

```ts
import { createDaemon } from '@schedjs/daemon';
import { createHttpRunner, createDockerRunner, type Runner } from '@schedjs/core';

const echoRunner: Runner = {
  async run(task, runId, startedAt) {
    const message = (task.config as { message?: string }).message ?? 'hello';
    return {
      status: 'succeeded',
      result: { message, runId },
      log: `echo: ${message}`,
    };
  },
};

const daemon = createDaemon({
  dbPath: 'sched.db',
  tasksPath: 'tasks.json',
  runners: {
    http: createHttpRunner(),
    docker: createDockerRunner(),
    echo: echoRunner,
  },
});

await daemon.start();
```

Then reference it from `tasks.json`:

```json
{
  "tasks": [
    {
      "name": "greet",
      "schedules": [{ "cron": "* * * * *" }],
      "runner": "echo",
      "config": { "message": "hello from sched" }
    }
  ]
}
```

A cron schedule is an object — `{ "cron": "* * * * *" }` (a bare cron string
`"* * * * *"` is not valid and fails at load). A cron object may carry an
optional `timezone` (IANA, e.g. `"Europe/Moscow"`) — defaults to the task's
`tz` / UTC.

## Fail-fast

An unregistered runner never silently no-ops:

- **At daemon start** — `tasks.json` referencing a runner that isn't in the map aborts
startup: `task "greet": runner "echo" not implemented in this build (registered: http, docker)`.
- **At dispatch** — if a runner disappears after start, the run fails fast instead of
hanging: `runner "echo": not implemented in this build`.

## Async runners — accepted + poll

For long-running jobs, return `accepted` and implement `poll`. Example — a worker that
queues the work and reports progress:

```ts
import { createDaemon } from '@schedjs/daemon';
import type { Runner } from '@schedjs/core';

const asyncRunner: Runner = {
  async run() {
    return { status: 'accepted', statusUrl: 'http://worker.local/status/42', pollIntervalMs: 1000 };
  },
  async poll(_runId, statusUrl) {
    const res = await fetch(statusUrl);
    const body = await res.json();
    if (!res.ok) throw new Error(`poll ${statusUrl} failed: ${res.status}`);
    return body; // { status: 'running', progress: 50 } | { status: 'succeeded', result }
  },
};
```

Notes:

- If `run` returns `accepted` but the runner has no `poll()`, the run fails fast.
- Poll failures (non-2xx, malformed envelope) throw → the run is marked `failed`.
- `pollTimeoutMs` (default 25 min, must be < `lockTtlMs` — 5 min margin under the 30 min default so the poll fails a hung async run before the zombie watchdog can re-dispatch it) caps a hung async run.
- The poll queue is in-memory — a daemon restart leaves the run `queued`; idempotency by
`runId` closes the gap.

## Artifacts — the runner owns them

sched never generates reports or sends content emails — the runner does, it has the
data and the credentials. Return a reference and let sched store and display it:

```ts
const reportingRunner: Runner = {
  async run(task, runId) {
    const markdown = `# ${task.name} report\n...`;
    // Upload yourself (S3/Minio, email, webhook…) — this is your job, not sched's
    const s3Key = await uploadToS3(`task-reports/${runId}.md`, markdown);
    return {
      status: 'succeeded',
      result: { summary: { rows: 42 } },
      artifacts: [{ kind: 's3', ref: `s3://bucket/${s3Key}`, label: 'Report' }],
    };
  },
};
```

Rules of thumb:

- **Upload failure is soft** — report it in `error`/`result`, don't fail the run over a
missing upload.
- **Retries re-use** — if the artifact already exists (ref set), don't re-generate.
- **Content emails go out from the worker** — sched only stores the receipt
(`kind: 'email'`).

## Reference implementations

- `packages/core/src/runners/http.ts` — request/response runner (sync + accepted/poll)
- `packages/core/src/runners/docker.ts` — container runner (spawn, log ring-buffer, exit codes)
- `packages/core/src/runners/process.ts` — local command runner (exit-code + stdio envelope modes)
- `packages/core/src/runners/exec.ts` — shared lifecycle (spawn → ring-buffer → timeout → close)

## A complete reference

The simplest complete from-scratch runner — a **file-drop** runner — is on its own page:
[Reference: file runner](custom/file-runner). Zero dependencies — filesystem only, so it runs anywhere.
