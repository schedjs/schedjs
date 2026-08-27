import { randomUUID } from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Engine } from '@schedjs/core';
import type { RunFilter, ScheduleListFilter, Storage, TaskListFilter } from '@schedjs/core';
import { createTaskOps, type TaskOps } from '@schedjs/core';
import {
  initialNextRun,
  parseScheduleEntry,
  upsertTaskDefinition,
  type ScheduleEntry,
  type TaskDefinition,
  type ParsedEntry,
} from '@schedjs/core';
import type { RunRecord, RunStatus, ScheduleRecord, TaskRecord } from '@schedjs/core';

/** @schedjs/admin-api version, read from the package manifest at runtime (dist/../package.json). */
const PACKAGE_VERSION = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/**
 * id → status for the list views, resolved in ONE pass (r6 F10 — the browser
 * must not N+1 per row). listRuns is DESC by startedAt with a 1000 cap, so a
 * task whose last run fell out of the recent window resolves to null (the UI
 * renders '—').
 */
async function lastRunStatusMap(storage: Storage): Promise<Map<string, RunStatus>> {
  const runs = await storage.listRuns({ limit: 1000 });
  return new Map(runs.map((r) => [r.id, r.status]));
}

export interface AdminApiOptions {
  /** Engine surface the API drives (trigger + manual retry + user cancel). */
  engine: Pick<Engine, 'triggerTask' | 'retryRun' | 'cancelRun'>;
  storage: Storage;
  /** Task ops (pause/resume/disable/enable). Default: createTaskOps(storage). */
  taskOps?: TaskOps;
  /**
   * Optional artifact reader (S3/Minio proxy, books-style). When set, adds
   * `GET /runs/:id/artifacts/:idx` — streams a stored `s3://` artifact so the
   * bucket can stay private. Only `s3`-kind refs are proxied; url/file/email are
   * direct links.
   */
  artifactsReader?: ArtifactReader;
  /**
   * Auth config. When `apiKey` is set, every request must carry
   * `Authorization: Bearer <apiKey>` — otherwise 401. Unset → open (dev mode).
   */
  auth?: { apiKey?: string };
  /**
   * Product version reported by `/health` (the daemon passes its own).
   * Default: the @schedjs/admin-api package version.
   */
  version?: string;
  /**
   * Injectable clock for nextRunAt recomputation (POST /tasks,
   * POST /tasks/:name/schedule). Default: `() => new Date()`.
   */
  now?: () => Date;
}

/** Reads one object by `s3://bucket/key` ref. Returns null when missing. */
export interface ArtifactReader {
  get(ref: string): Promise<{ contentType: string; body: Buffer } | null>;
}

export interface AdminApi {
  server: Server;
  /** Dispatch one request (middleware form — lets the host route /api/*). */
  handleRequest(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void>;
  /** Bind and resolve with the actual port (0 → ephemeral, for tests). */
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

const json = (res: import('node:http').ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // live control-plane data — never let the browser cache a snapshot
    // (a stale `/runs` could keep showing a task as "running")
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
};

const noContent = (res: import('node:http').ServerResponse): void => {
  res.writeHead(204, { 'cache-control': 'no-store' });
  res.end();
};

const MAX_BODY = 1024 * 1024;

/** Read a request body as text, capped at 1 MB (admin api JSON is tiny). */
function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large (max 1 MB)'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** Client error with an explicit HTTP status — handled by dispatch (400/404/405). */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Read a request body and parse it as a JSON object; throws HttpError(400) on malformed input. */
async function readJsonObject(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (raw.trim().length === 0) throw new HttpError(400, 'expected a JSON body');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

/**
 * Admin HTTP API — the control plane for the sched daemon and for embedding
 * (books). Plain `node:http`, zero dependencies; JSON in/out. All statuses are
 * sched-native (RunStatus); books-specific concerns (S3 report) stay books-side.
 *
 * Native routes (no mount prefix — this package serves them as-is). The sched
 * daemon mounts the admin server under `/api/*` and strips the prefix before
 * dispatching, so an operator reaches these at `/api/…` (e.g. the health probe
 * is `GET /api/health`, not `/health` — books T2 finding 2026-08-22):
 *   GET    /health                      → { ok, uptimeMs, version }
 *   GET    /runs?task=&status=&limit=&offset= → { runs } (newest first)
 *   GET    /runs/:id                    → RunRecord | 404
 *   DELETE /runs/:id                    → 204 | 404 | 409 (active — cancel first)
 *   POST   /runs/:id/retry              → { run } | 404/409  (manual retry)
 *   POST   /runs/:id/cancel             → { run } | 404/409  (user cancel)
 *   GET    /runs/:id/artifacts/:idx     → artifact body | 400/404/501 (s3 proxy)
 *   GET    /tasks?limit=&offset=        → { tasks } (name ASC)
 *   POST   /tasks                       → { task } | 400  (runtime registration, upsert)
 *   GET    /tasks/:name                 → TaskRecord | 404
 *   DELETE /tasks/:name                 → 204 | 404  (remove a task; runs kept)
 *   POST   /tasks/:name/run             → { run } | 404   (ad-hoc trigger)
 *   POST   /tasks/:name/pause|resume    → { ok } | 404
 *   GET    /schedules?limit=&offset=    → { schedules } (schedule-as-entity + lastRunStatus + effectiveStatus)
 *   POST   /schedules                   → { schedule } | 400/404  (create/upsert by dedupKey — 201 created / 200 updated)
 *   GET    /schedules/:id               → ScheduleRecord | 404
 *   DELETE /schedules/:id               → 204 | 404  (remove a schedule; runs kept)
 *   POST   /schedules/:id/pause|resume  → { ok } | 404
 *
 * Legacy `POST /tasks/:name/schedule` is REMOVED (schedule-as-entity hard cut,
 * decision 2026-08-18) — 404 pointing to `POST /schedules`.
 *
 * Auth: Bearer token when `auth.apiKey` is configured (401 otherwise). Exception:
 * `GET /health` is ALWAYS open — probe for compose healthchecks / LB (F&F F-1).
 * (On the daemon's wire this is `GET /api/health` — see the mount note above.)
 */
export function createAdminApi(options: AdminApiOptions): AdminApi {
  const { storage } = options;
  const taskOps = options.taskOps ?? createTaskOps(storage);
  const apiKey = options.auth?.apiKey;
  const clock = options.now ?? (() => new Date());

  const authorized = (req: import('node:http').IncomingMessage): boolean => {
    if (!apiKey) return true;
    const header = req.headers.authorization;
    if (typeof header !== 'string') return false;
    // constant-time compare — the key is a secret even on a loopback bind
    const a = Buffer.from(header);
    const b = Buffer.from(`Bearer ${apiKey}`);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  /** [method, pathname] → handler; ':id'/'name' segments captured via regex. */
  async function dispatch(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = req.method ?? 'GET';

      // --- health ---
      // Health probe is OPEN even when auth.apiKey is set (F&F openapi-client
      // F-1): compose healthchecks / LB probes carry no credentials, and the
      // payload (ok/uptime/version) contains no secrets. Everything else 401s.
      if (method === 'GET' && path === '/health') {
        json(res, 200, { ok: true, uptimeMs: process.uptime() * 1000, version: options.version ?? PACKAGE_VERSION });
        return;
      }

      if (!authorized(req)) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }

        // --- runs ---
        if (path === '/runs' && method === 'GET') {
          const filter: RunFilter = {};
          const task = url.searchParams.get('task');
          if (task !== null) filter.taskName = task;
          const status = url.searchParams.get('status');
          if (status !== null) filter.status = status as RunStatus;
          const limit = num(url.searchParams.get('limit'));
          if (limit !== undefined) filter.limit = limit;
          const offset = num(url.searchParams.get('offset'));
          if (offset !== undefined) filter.offset = offset;
          json(res, 200, { runs: await storage.listRuns(filter) });
          return;
        }
        const artifactMatch = path.match(/^\/runs\/([^/]+)\/artifacts\/(\d+)$/);
        if (artifactMatch) {
          if (method !== 'GET') return json(res, 405, { error: 'method not allowed' });
          const runId = decodeURIComponent(artifactMatch[1]!);
          const idx = Number(artifactMatch[2]);
          const run = await storage.getRun(runId);
          if (!run) return json(res, 404, { error: `run ${runId} not found` });
          const artifact = run.artifacts?.[idx];
          if (!artifact) return json(res, 404, { error: `artifact ${idx} not found` });
          if (artifact.kind !== 's3') {
            return json(res, 400, { error: `artifact kind '${artifact.kind}' is a direct link, not proxied` });
          }
          if (!options.artifactsReader) {
            return json(res, 501, { error: 'artifact proxy not configured (no artifactsReader)' });
          }
          const obj = await options.artifactsReader.get(artifact.ref);
          if (!obj) return json(res, 404, { error: `artifact ${artifact.ref} not found` });
          res.writeHead(200, { 'content-type': obj.contentType, 'content-length': obj.body.length, 'cache-control': 'no-cache' });
          res.end(obj.body);
          return;
        }
        const retryMatch = path.match(/^\/runs\/([^/]+)\/retry$/);
        if (retryMatch) {
          if (method !== 'POST') return json(res, 405, { error: 'method not allowed' });
          const id = decodeURIComponent(retryMatch[1]!);
          const run = await storage.getRun(id);
          if (!run) return json(res, 404, { error: `run ${id} not found` });
          // optional JSON body { triggeredBy? } — who retries now (fresh actor, never inherited)
          const raw = await readBody(req);
          let opts: { triggeredBy?: string | null } | undefined;
          if (raw.trim().length > 0) {
            let body: unknown;
            try {
              body = JSON.parse(raw);
            } catch {
              return json(res, 400, { error: 'invalid JSON body (expected { triggeredBy? })' });
            }
            if (typeof body !== 'object' || body === null || Array.isArray(body)) {
              return json(res, 400, { error: 'body must be an object: { triggeredBy? }' });
            }
            const { triggeredBy } = body as Record<string, unknown>;
            if (triggeredBy !== undefined && triggeredBy !== null && typeof triggeredBy !== 'string') {
              return json(res, 400, { error: 'triggeredBy must be a string or null' });
            }
            if (triggeredBy !== undefined) opts = { triggeredBy };
          }
          const retried = await options.engine.retryRun(id, opts);
          if (!retried) return json(res, 409, { error: `task ${run.taskName} not found` });
          json(res, 200, { run: retried });
          return;
        }
        const cancelMatch = path.match(/^\/runs\/([^/]+)\/cancel$/);
        if (cancelMatch) {
          if (method !== 'POST') return json(res, 405, { error: 'method not allowed' });
          const id = decodeURIComponent(cancelMatch[1]!);
          const run = await storage.getRun(id);
          if (!run) return json(res, 404, { error: `run ${id} not found` });
          if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') {
            return json(res, 409, { error: `run ${id} already finished (${run.status})` });
          }
          const cancelled = await options.engine.cancelRun(id);
          json(res, 200, { run: cancelled ?? run });
          return;
        }
        const runMatch = path.match(/^\/runs\/([^/]+)$/);
        if (runMatch) {
          const id = decodeURIComponent(runMatch[1]!);
          if (method === 'GET') {
            const run = await storage.getRun(id);
            if (!run) return json(res, 404, { error: `run ${id} not found` });
            const logFromOffset = num(url.searchParams.get('logFromOffset'));
            if (logFromOffset !== undefined) {
              // incremental log read (books parity): instead of the full log,
              // return logChunk (tail from the offset) + logTotalLength so the
              // UI can poll for growth. Offset 0 → the whole log as a chunk.
              // Prod defect 5 (books post-cutover 2026-08-22): migrated runs can
              // carry `log` as an object (the legacy column held JSON) — coerce
              // to a string so the slice never TypeErrors and the UI renders it.
              const logStr =
                typeof run.log === 'string'
                  ? run.log
                  : run.log === null || run.log === undefined
                    ? ''
                    : JSON.stringify(run.log);
              json(res, 200, {
                ...run,
                log: null,
                logChunk: logStr.slice(logFromOffset) ?? '',
                logTotalLength: logStr.length,
              });
              return;
            }
            json(res, 200, run);
            return;
          }
          if (method === 'DELETE') {
            const run = await storage.getRun(id);
            if (!run) return json(res, 404, { error: `run ${id} not found` });
            // active runs (running/queued) must be cancelled first — deleting
            // them would orphan the in-flight work (books parity)
            if (run.status === 'running' || run.status === 'queued') {
              return json(res, 409, { error: `run ${id} is ${run.status} — cancel it first (POST /runs/${id}/cancel)` });
            }
            await storage.deleteRun(id);
            noContent(res);
            return;
          }
          return json(res, 405, { error: 'method not allowed' });
        }

        // --- tasks ---
        if (path === '/tasks') {
          if (method === 'GET') {
            const filter: TaskListFilter = {};
            const limit = num(url.searchParams.get('limit'));
            if (limit !== undefined) filter.limit = limit;
            const offset = num(url.searchParams.get('offset'));
            if (offset !== undefined) filter.offset = offset;
            // r6 F10: the list view shows how the last run ended — resolve server-side, one pass.
            const runStatus = await lastRunStatusMap(storage);
            const tasks = await storage.listTasks(filter);
            json(res, 200, {
              tasks: tasks.map((t) => ({
                ...t,
                lastRunStatus: t.lastRunId !== null ? (runStatus.get(t.lastRunId) ?? null) : null,
              })),
            });
            return;
          }
          if (method === 'POST') {
            // Runtime registration (upsert): a full TaskDefinition, validated
            // exactly like tasks.json (fail-fast) — see upsertTaskDefinition.
            const body = await readJsonObject(req);
            const name = body.name;
            if (typeof name !== 'string' || name.length === 0) {
              throw new HttpError(400, 'task name must be a non-empty string');
            }
            const existed = (await storage.getTask(name)) !== null;
            let task: TaskRecord;
            try {
              task = await upsertTaskDefinition(storage, body as unknown as TaskDefinition, clock());
            } catch (err) {
              // tasks.json-prefixed validation message → API context
              throw new HttpError(400, err instanceof Error ? err.message.replace(/^tasks\.json: /, '') : String(err));
            }
            json(res, existed ? 200 : 201, { task });
            return;
          }
          return json(res, 405, { error: 'method not allowed' });
        }
        const taskMatch = path.match(/^\/tasks\/([^/]+)(?:\/([^/]+))?$/);
        if (taskMatch) {
          const name = decodeURIComponent(taskMatch[1]!);
          if (!taskMatch[2]) {
            if (method === 'GET') {
              const task = await storage.getTask(name);
              if (!task) return json(res, 404, { error: `task ${name} not found` });
              json(res, 200, task);
              return;
            }
            if (method === 'DELETE') {
              // r7 F1 companion: runtime-registered tasks live until deleted —
              // sync never removes them, so the API must (runs keep their history).
              const task = await storage.getTask(name);
              if (!task) return json(res, 404, { error: `task ${name} not found` });
              await storage.deleteTask(name);
              noContent(res);
              return;
            }
            return json(res, 405, { error: 'method not allowed' });
          }
          const action = taskMatch[2];
          if (method !== 'POST') return json(res, 405, { error: 'method not allowed' });
          if (action === 'run') {
            // optional JSON body { temporary?, data?, triggeredBy? } — see triggerTask docs
            const raw = await readBody(req);
            let opts: { temporary?: boolean; data?: unknown; triggeredBy?: string | null } | undefined;
            if (raw.trim().length > 0) {
              let body: unknown;
              try {
                body = JSON.parse(raw);
              } catch {
                return json(res, 400, { error: 'invalid JSON body (expected { temporary?, data?, triggeredBy? })' });
              }
              if (typeof body !== 'object' || body === null || Array.isArray(body)) {
                return json(res, 400, { error: 'body must be an object: { temporary?, data?, triggeredBy? }' });
              }
              const { temporary, data, triggeredBy } = body as Record<string, unknown>;
              if (temporary !== undefined && typeof temporary !== 'boolean') {
                return json(res, 400, { error: 'temporary must be a boolean' });
              }
              if (triggeredBy !== undefined && triggeredBy !== null && typeof triggeredBy !== 'string') {
                return json(res, 400, { error: 'triggeredBy must be a string or null' });
              }
              opts = {
                ...(temporary !== undefined ? { temporary } : {}),
                ...(data !== undefined ? { data } : {}),
                ...(triggeredBy !== undefined ? { triggeredBy } : {}),
              };
            }
            const run = await options.engine.triggerTask(name, opts);
            if (!run) return json(res, 404, { error: `task ${name} not found` });
            json(res, 200, { run });
            return;
          }
          if (action === 'schedule') {
            // HARD CUT (decision 2026-08-18): the legacy per-task schedule
            // endpoint is removed — imperative schedules live on POST /schedules
            // (schedule-as-entity). 404 with the migration pointer.
            throw new HttpError(
              404,
              `POST /tasks/:name/schedule is removed — create schedules via POST /schedules (schedule-as-entity)`,
            );
          }
          if (action === 'pause' || action === 'resume') {
            const task = await storage.getTask(name);
            if (!task) return json(res, 404, { error: `task ${name} not found` });
            if (action === 'pause') await taskOps.pauseTask(name);
            else await taskOps.resumeTask(name);
            json(res, 200, { ok: true, name, paused: action === 'pause' });
            return;
          }
          return json(res, 404, { error: `unknown action ${action}` });
        }

        // --- schedules (schedule-as-entity: imperative create/upsert + first-class list) ---
        if (path === '/schedules' && method === 'POST') {
          const body = await readJsonObject(req);
          // F&F openapi-client F-5: fail-fast on unknown top-level fields — a
          // silent-ignore (e.g. top-level dedupKey creating a NEW schedule) is
          // a contract violation, not a convenience.
          const unknownTop = Object.keys(body).filter((k) => !['taskName', 'schedule', 'tz'].includes(k));
          if (unknownTop.length > 0) {
            throw new HttpError(
              400,
              `unknown field(s) on schedule body: ${unknownTop.join(', ')} (tenant/policy fields live inside 'schedule')`,
            );
          }
          const taskName = body.taskName;
          if (typeof taskName !== 'string' || taskName.length === 0) {
            throw new HttpError(400, 'taskName must be a non-empty string');
          }
          const task = await storage.getTask(taskName);
          if (!task) return json(res, 404, { error: `task ${taskName} not found` });
          const tz = body.tz;
          if (tz !== undefined && (typeof tz !== 'string' || tz.length === 0)) {
            throw new HttpError(400, 'tz must be a non-empty string');
          }
          const rawEntry = body.schedule;
          if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) {
            throw new HttpError(400, 'schedule must be an object: { cron | interval | once, timezone?, data?, externalId?, dedupKey?, retry?, priority? }');
          }
          let entry: ParsedEntry;
          try {
            // fail-fast validation identical to tasks.json (parseScheduleEntry);
            // tz defaults to the TASK's timezone (v1 parity), entry.timezone overrides.
            entry = parseScheduleEntry(taskName, rawEntry, { now: clock(), tz: (tz as string | undefined) ?? task.tz });
          } catch (err) {
            throw new HttpError(400, err instanceof Error ? err.message.replace(/^tasks\.json: /, '') : String(err));
          }
          // imperative schedules get a fresh UUID id; dedupKey (when given) is the
          // stable upsert handle — a second POST with the same key updates in place.
          const id = randomUUID();
          const schedule = await storage.createSchedule({
            id,
            taskName,
            schedule: entry.schedule,
            tz: entry.tz,
            data: entry.data,
            externalId: entry.externalId,
            dedupKey: entry.dedupKey,
            nextRunAt: initialNextRun(entry.schedule, entry.tz, clock()),
            lastRunAt: null,
            lockedAt: null,
            failCount: 0,
            priority: entry.priority ?? task.priority,
            retry: entry.retry,
            retryCount: 0,
            lastRunId: null,
            paused: false,
            disabled: false,
            fileManaged: false, // runtime-owned — sync never disables it (r7 F1 parity)
          });
          // created vs updated: the dedup upsert preserves the EXISTING id on a
          // key collision — a returned id different from the fresh UUID = update.
          json(res, schedule.id === id ? 201 : 200, { schedule });
          return;
        }
        if (path === '/schedules' && method === 'GET') {
          const filter: ScheduleListFilter = {};
          const limit = num(url.searchParams.get('limit'));
          if (limit !== undefined) filter.limit = limit;
          const offset = num(url.searchParams.get('offset'));
          if (offset !== undefined) filter.offset = offset;
          // three reads, no N+1: schedules + tasks (effectiveStatus) + run-status map
          const [schedules, tasks, runStatus] = await Promise.all([
            storage.listSchedules(filter),
            storage.listTasks(),
            lastRunStatusMap(storage),
          ]);
          const taskPaused = new Map(tasks.map((t) => [t.name, t.paused]));
          json(res, 200, {
            schedules: schedules.map((s) => ({
              ...s,
              lastRunStatus: s.lastRunId !== null ? (runStatus.get(s.lastRunId) ?? null) : null,
              // AND-semantics made visible: which level is holding this schedule
              effectiveStatus: taskPaused.get(s.taskName)
                ? 'paused-task'
                : s.paused
                  ? 'paused-schedule'
                  : 'active',
            })),
          });
          return;
        }
        const scheduleActionMatch = path.match(/^\/schedules\/([^/]+)\/(pause|resume)$/);
        if (scheduleActionMatch) {
          if (method !== 'POST') return json(res, 405, { error: 'method not allowed' });
          const id = decodeURIComponent(scheduleActionMatch[1]!);
          const action = scheduleActionMatch[2]!;
          const schedule = await storage.getSchedule(id);
          if (!schedule) return json(res, 404, { error: `schedule ${id} not found` });
          if (action === 'pause') await taskOps.pauseSchedule(id);
          else await taskOps.resumeSchedule(id);
          json(res, 200, { ok: true, id, paused: action === 'pause' });
          return;
        }
        const scheduleMatch = path.match(/^\/schedules\/([^/]+)$/);
        if (scheduleMatch) {
          const id = decodeURIComponent(scheduleMatch[1]!);
          if (method === 'GET') {
            const schedule = await storage.getSchedule(id);
            if (!schedule) return json(res, 404, { error: `schedule ${id} not found` });
            const task = await storage.getTask(schedule.taskName);
            const lastRun = schedule.lastRunId !== null ? await storage.getRun(schedule.lastRunId) : null;
            json(res, 200, {
              ...schedule,
              lastRunStatus: lastRun?.status ?? null,
              effectiveStatus: task?.paused ? 'paused-task' : schedule.paused ? 'paused-schedule' : 'active',
            });
            return;
          }
          if (method === 'PATCH') {
            // Edit a schedule (slice 5 — the schedules form): update the rule /
            // tz / data / tenant fields / policy in place. nextRunAt recomputes
            // from now when the rule or tz changed; runtime state (lock, fail,
            // retry, lastRun) is preserved. 404 on unknown id.
            // r8 #4 F3: PATCH is a partial merge — only fields PRESENT in the
            // body change; absent fields keep their current value (an explicit
            // null clears). A rule-only patch must not silently null tenant/
            // policy fields (dedupKey is the upsert handle — losing it would
            // let the next dedup-upsert duplicate the schedule).
            const schedule = await storage.getSchedule(id);
            if (!schedule) return json(res, 404, { error: `schedule ${id} not found` });
            const body = await readJsonObject(req);
            // F&F openapi-client F-5: PATCH is a partial merge over { schedule, tz }
            // only — anything else is a contract violation (re-targeting a
            // schedule to another task is a delete+create, not a patch).
            const unknownPatch = Object.keys(body).filter((k) => !['schedule', 'tz'].includes(k));
            if (unknownPatch.length > 0) {
              throw new HttpError(400, `unknown field(s) on schedule patch: ${unknownPatch.join(', ')}`);
            }
            const tz = body.tz;
            if (tz !== undefined && (typeof tz !== 'string' || tz.length === 0)) {
              throw new HttpError(400, 'tz must be a non-empty string');
            }
            const rawEntry = body.schedule;
            if (rawEntry !== undefined && (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry))) {
              throw new HttpError(400, 'schedule must be an object: { cron | interval | once, timezone?, data?, externalId?, dedupKey?, retry?, priority? }');
            }
            const patch: Record<string, unknown> = {};
            let entry: ParsedEntry | null = null;
            if (rawEntry !== undefined) {
              try {
                entry = parseScheduleEntry(schedule.taskName, rawEntry, {
                  now: clock(),
                  tz: (tz as string | undefined) ?? schedule.tz,
                });
              } catch (err) {
                throw new HttpError(
                  400,
                  err instanceof Error ? err.message.replace(/^tasks\.json: /, '') : String(err),
                );
              }
              patch.schedule = entry.schedule;
              patch.tz = entry.tz;
              // presence-based merge: absent → keep current, present (incl.
              // explicit null) → set. parseScheduleEntry collapses "unset" to
              // null, so read presence off the RAW body, not the parsed entry.
              const raw = rawEntry as Record<string, unknown>;
              if ('data' in raw) patch.data = raw.data;
              if ('externalId' in raw) patch.externalId = raw.externalId;
              if ('dedupKey' in raw) patch.dedupKey = raw.dedupKey;
              if ('retry' in raw) patch.retry = raw.retry;
              if ('priority' in raw) patch.priority = raw.priority;
            } else if (tz !== undefined) {
              patch.tz = tz;
            }
            // recompute nextRunAt only when the rule or tz actually changed
            const effectiveTz = (patch.tz as string | undefined) ?? schedule.tz;
            if (entry !== null && JSON.stringify(entry.schedule) !== JSON.stringify(schedule.schedule)) {
              patch.nextRunAt = initialNextRun(entry.schedule, effectiveTz, clock());
            } else if (tz !== undefined && tz !== schedule.tz) {
              patch.nextRunAt = initialNextRun(schedule.schedule, effectiveTz, clock());
            }
            await storage.updateSchedule(id, patch);
            json(res, 200, { schedule: await storage.getSchedule(id) });
            return;
          }
          if (method === 'DELETE') {
            const schedule = await storage.getSchedule(id);
            if (!schedule) return json(res, 404, { error: `schedule ${id} not found` });
            await storage.deleteSchedule(id); // runs keep their history — audit survives
            noContent(res);
            return;
          }
          return json(res, 405, { error: 'method not allowed' });
        }

        json(res, 404, { error: 'not found' });
      } catch (err) {
        if (err instanceof HttpError) {
          json(res, err.status, { error: err.message });
          return;
        }
        json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
  }

  const server = createServer((req, res) => {
    void dispatch(req, res);
  });

  return {
    server,
    handleRequest: dispatch,
    listen(port = 0, host = '127.0.0.1'): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : port);
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function num(v: string | null): number | undefined {
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
