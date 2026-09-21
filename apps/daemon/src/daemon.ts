import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createAlerts,
  createDockerRunner,
  createEngine,
  createEventLogger,
  createHttpRunner,
  createProcessRunner,
  createSqliteStorage,
  createSshRunner,
  loadTasksJson,
  readTasksJsonAlertsSync,
  readTasksJsonTaskAlertsSync,
  readTasksJsonRunnersSync,
  syncTasks,
} from '@schedjs/core';
import { createAdminApi } from '@schedjs/admin-api';
import { createMcpRunner } from '@schedjs/mcp';
import type { AdminApi } from '@schedjs/admin-api';
import type { Engine, Runner, Storage } from '@schedjs/core';

/** @schedjs/daemon version — reported via /health (the shell footer shows it). */
const DAEMON_VERSION = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export interface DaemonAdminOptions {
  /** Port to bind the admin api on. */
  port: number;
  /** Bind host. Default: 127.0.0.1. */
  host?: string;
  /** Required Bearer token (SCHED_ADMIN_KEY). Unset → open (dev mode). */
  apiKey?: string;
}

export interface DaemonOptions {
  /** Path to the tasks.json desired-state file. */
  tasksPath: string;
  /**
   * External storage adapter (mysql / postgres / mongo / custom) to run the
   * daemon on (r6 D1: docs promised `createDaemon({ storage })`, the daemon
   * hardcoded sqlite). Omit → SQLite at `dbPath`.
   */
  storage?: Storage;
  /** SQLite database path (':memory:' allowed). Required when `storage` is omitted. */
  dbPath?: string;
  /** Runner implementations by name (default: { http, docker, process, ssh, mcp }). */
  runners?: Record<string, Runner>;
  /** Admin control plane: JSON api under /api/* + morda at / (same origin). */
  admin?: DaemonAdminOptions;
  /** Status alerts: webhook on terminal run states / missed slots. See createAlerts. */
  alerts?: import('@schedjs/core').AlertsConfig;  /**
   * A schedule dispatched more than this many ms after its slot fires a
   * missed-slot alert (engine `missedSlotGraceMs`). Default: 120_000.
   */
  missedSlotGraceMs?: number;
  /**
   * Object-storage (Minio/S3) credentials for the artifact proxy
   * (`GET /api/runs/:id/artifacts/:idx`). Omit → direct-link mode (UI builds
   * URLs from refs itself).
   */
  artifactsS3?: {
    endpoint: string;
    region?: string;
    forcePathStyle?: boolean;
    accessKeyId: string;
    secretAccessKey: string;
  };
  now?: () => Date;
  lockTtlMs?: number;
  /**
   * Lock-heartbeat cadence for long sync runs (engine `lockHeartbeatMs`).
   * Must be < lockTtlMs. Default: lockTtlMs / 3 (10 min at the 30 min default).
   */
  lockHeartbeatMs?: number;
  /** Retention TTL for regular terminal runs, measured from finishedAt. Default: 30d. */
  retentionMs?: number;
  /** Retention TTL for `temporary: true` runs. Default: 24h. */
  temporaryRetentionMs?: number;
  tickIntervalMs?: number;
  watchdogIntervalMs?: number;
  /**
   * Hard ceiling for an async (accepted) run, measured from acceptance. Must be
   * < lockTtlMs. Default: 25 min (see engine docs). Passed run → failed.
   */
  pollTimeoutMs?: number;
  /** Poll cadence for accepted runs. Default: 1000 ms. */
  pollIntervalMs?: number;
  /**
   * Live tasks.json sync cadence: the file is re-read and reconciled on this
   * interval (new/changed/removed tasks), so edits are picked up without a
   * restart. A broken file at runtime is ignored with a log (last good state
   * stays) — fail-fast applies only to the startup load. Default: 60 s.
   */
  syncIntervalMs?: number;
  /**
   * Start with the queue frozen (R2 pause): the daemon boots paused and claims
   * no new runs until `POST /queue/resume` (admin API). `pausedAt` is the
   * process-start time and `getPauseInfo().startPaused` is true — "frozen since
   * start", not an operator command. The state is runtime-only: a restart
   * without this option starts active. Wired from the explicit option or the
   * `SCHED_START_PAUSED=1` ENV fallback (read by `createDaemon`); there is
   * deliberately no CLI flag (the env covers compose / Portainer).
   */
  startPaused?: boolean;
}

export interface Daemon {
  storage: Storage;
  engine: Engine;
  /** Composed admin server (/api/* → admin api, else static morda). Set after start() when admin configured. */
  getAdminServer(): Server | undefined;
  /** Admin api (JSON control plane). Set after start() when admin configured. */
  getAdminApi(): AdminApi | undefined;
  /** Load tasks.json → validate runners → sync → recover orphan runs → start the engine loops. */
  start(): Promise<void>;
  /** Stop the loops and close the database. */
  stop(): void;
  /**
   * One live-sync pass (idempotent): re-read tasks.json and reconcile. A
   * broken/missing file is logged and skipped — the daemon keeps running with
   * the last good state. Used by the sync interval and available for forced
   * re-syncs.
   */
  runSyncOnce(): Promise<void>;
}

/**
 * Standalone daemon: SQLite file + per-task runners + tasks.json desired state
 * in one process. This is the "install in 60 seconds" surface —
 * `sched --tasks tasks.json`. Each task's `runner` field selects its
 * implementation from the registered map; a task whose runner is not
 * registered fails fast at start (no silent no-ops).
 */
export function createDaemon(options: DaemonOptions): Daemon {
  // Process-start time for the `startPaused` freeze (pausedAt must say "since
  // boot", not "when the sync pass happened"; `now` is the injectable clock).
  const processStartedAt = options.now ? options.now() : new Date();
  // R2: the freeze is driven by the explicit option; `SCHED_START_PAUSED=1` is
  // the ENV fallback for compose/Portainer. An explicit `startPaused: false`
  // wins (the only way to override a stray env in the process).
  const startPaused = options.startPaused ?? process.env.SCHED_START_PAUSED === '1';
  // r6 D1: an explicit storage adapter wins; sqlite is only the default backend.
  const db = options.storage ? null : new DatabaseSync(options.dbPath!);
  const storage = options.storage ?? createSqliteStorage(db!);
  // Runners: an explicit embedded override wins; otherwise the default registry
  // is built with the sandbox ceilings from tasks.json `runners` (read sync —
  // createDaemon is sync, start() is where the async load happens).
  const fileRunners = options.runners ? undefined : readTasksJsonRunnersSync(options.tasksPath);
  const runners = options.runners ?? {
    http: createHttpRunner(),
    docker: createDockerRunner(fileRunners?.docker),
    process: createProcessRunner(fileRunners?.process),
    ssh: createSshRunner(fileRunners?.ssh),
    mcp: createMcpRunner(fileRunners?.mcp),
  };

  // Dispatcher: the engine holds a single Runner seam; per-task selection
  // happens here, keyed by task.runner. `poll` is routed through the run record
  // (the engine only passes runId + statusUrl, no runner name) — the impl with
  // a poll() is looked up from the run's runner field.
  const runner: Runner = {
    run: (task, runId, startedAt, hooks) => {
      const impl = runners[task.runner];
      if (!impl) {
        throw new Error(`runner "${task.runner}": not implemented in this build (registered: ${Object.keys(runners).join(', ') || 'none'})`);
      }
      return impl.run(task, runId, startedAt, hooks);
    },
    poll: async (runId, statusUrl, task) => {
      const run = await storage.getRun(runId);
      const impl = run ? runners[run.runner] : undefined;
      const pollImpl = impl?.poll;
      if (!pollImpl) {
        throw new Error(`runner "${run?.runner ?? '?'}": no poll() implementation`);
      }
      return pollImpl(runId, statusUrl, task);
    },
    // Async-cancel channel: forward to the per-task runner (the engine passes
    // the originating task; only http/custom runners produce accepted runs, and
    // only they may implement cancel). No impl/no hook → no-op — the engine
    // still finishes the run cancelled (legacy stop-polling semantics).
    cancel: async (runId, statusUrl, task, cancelUrl) => {
      const impl = task ? runners[task.runner] : undefined;
      const cancelImpl = impl?.cancel;
      if (!cancelImpl) return;
      return cancelImpl(runId, statusUrl, task, cancelUrl);
    },
  };

  // Status alerts: programmatic `alerts` option wins over the top-level
  // `alerts` block + per-task `tasks[].alerts` blocks in tasks.json (file
  // reads are sync, like the runners block). Root block = channel + defaults;
  // per-task blocks = routing overrides folded into `tasks` (field-wise,
  // task wins, arrays replace — see createAlerts).
  const fileAlerts = options.alerts ? undefined : readTasksJsonAlertsSync(options.tasksPath);
  const fileTaskAlerts = options.alerts ? undefined : readTasksJsonTaskAlertsSync(options.tasksPath);
  const alertsConfig =
    options.alerts ??
    (fileAlerts !== undefined || (fileTaskAlerts && Object.keys(fileTaskAlerts).length > 0)
      ? { ...fileAlerts, ...(fileTaskAlerts ? { tasks: fileTaskAlerts } : {}) }
      : undefined);
  const alerts = alertsConfig ? createAlerts(alertsConfig) : null;

  // Cancel-channel observability (battle-stand debugging 2026-08-21): every
  // cancel attempt lands on stdout so the operator can tell «signal never
  // sent» from «sent and failed» from «acked». Filtered to cancel events — the
  // rest of the engine event stream stays on the alerts hook only.
  const cancelEventLogger = createEventLogger({
    filter: ['cancel-sent', 'cancel-ack', 'cancel-failed', 'cancel-no-channel'],
  });

  const engine = createEngine({
    storage,
    runner,
    ...(alerts ? { onRunFinal: alerts.handleFinal } : {}),
    // Cancel-channel observability on stdout (docker logs) — the battle-stand
    // debugging contract 2026-08-21: `[cancel] POST <url> runId=<id>` before,
    // `[cancel] ack status=<n>` / `[cancel] failed: <причина>` after,
    // `[cancel] no cancelUrl — legacy stop-polling` when the envelope had none.
    // The alerts hook (if configured) still receives every event.
    onEvent: (event) => {
      cancelEventLogger(event);
      if (alerts) alerts.handleEvent(event);
    },
    ...(options.missedSlotGraceMs !== undefined ? { missedSlotGraceMs: options.missedSlotGraceMs } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.lockTtlMs ? { lockTtlMs: options.lockTtlMs } : {}),
    ...(options.lockHeartbeatMs ? { lockHeartbeatMs: options.lockHeartbeatMs } : {}),
    ...(options.retentionMs !== undefined ? { retentionMs: options.retentionMs } : {}),
    ...(options.temporaryRetentionMs !== undefined ? { temporaryRetentionMs: options.temporaryRetentionMs } : {}),
    ...(options.tickIntervalMs ? { tickIntervalMs: options.tickIntervalMs } : {}),
    ...(options.watchdogIntervalMs ? { watchdogIntervalMs: options.watchdogIntervalMs } : {}),
    ...(options.pollTimeoutMs ? { pollTimeoutMs: options.pollTimeoutMs } : {}),
    ...(options.pollIntervalMs ? { pollIntervalMs: options.pollIntervalMs } : {}),
    // Audit (release-hardening #1051, item 2): lockTtlMs / lockHeartbeatMs /
    // pollTimeoutMs / tickIntervalMs / watchdogIntervalMs / pollIntervalMs stay
    // truthy-guarded on purpose — 0 is invalid for all of them (CLI enforces
    // > 0 via positiveNumber); a 0 that reached the engine would mean a busy
    // loop (tick/poll 0ms) or instant zombie-reap (lockTtlMs 0), so the falsy
    // drop is the safety, not the bug. Only retentionMs / temporaryRetentionMs /
    // missedSlotGraceMs legitimately accept 0 (retention off / no grace) and
    // use !== undefined.
  });

  let adminApi: AdminApi | undefined;
  let adminServer: Server | undefined;
  let syncTimer: NodeJS.Timeout | null = null;
  let syncing = false;
  let consecutiveSyncFailures = 0;

  async function startAdmin(): Promise<void> {
    if (!options.admin) return;
    adminApi = createAdminApi({
      engine,
      storage,
      // R2: the pause flag lives in the engine — hand the API the accessor so
      // GET/POST /queue drive the real queue, not a daemon-side mirror.
      queue: engine,
      version: DAEMON_VERSION,
      ...(options.artifactsS3 ? { artifactsReader: await createS3ArtifactReader(options.artifactsS3) } : {}),
      ...(options.admin.apiKey ? { auth: { apiKey: options.admin.apiKey } } : {}),
    });
    adminServer = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        // strip the /api mount prefix → the admin api sees its native routes
        req.url = url.pathname.replace(/^\/api/, '') + url.search;
        // Prod defect 1: a storage failure mid-request must not become an
        // unhandled rejection (the server loop is fire-and-forget) — respond
        // 500 and keep the daemon alive. The admin api already maps known
        // errors to status codes; this is the last-line boundary.
        void adminApi!.handleRequest(req, res).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          try {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: message }));
          } catch {
            // response already started/closed — nothing more we can do
          }
        });
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found — the admin UI ships separately: npx @schedjs/ui (sched-ui serve)');
      }
    });
    await new Promise<void>((resolve, reject) => {
      adminServer!.once('error', reject);
      adminServer!.listen(options.admin!.port, options.admin!.host ?? '127.0.0.1', () => resolve());
    });
  }

  const daemon: Daemon = {
    storage,
    engine,
    getAdminServer: () => adminServer,
    getAdminApi: () => adminApi,
    async start() {
      await startAdmin();
      const defs = await loadTasksJson(options.tasksPath);
      const registered = new Set(Object.keys(runners));
      for (const def of defs) {
        const name = def.runner ?? 'http';
        if (!registered.has(name)) {
          throw new Error(
            `tasks.json: task "${def.name}": runner "${name}" not implemented in this build (registered: ${[...registered].join(', ') || 'none'})`,
          );
        }
        const impl = runners[name];
        if (impl?.validateConfig) {
          try {
            impl.validateConfig(def);
          } catch (err) {
            throw new Error(`tasks.json: task "${def.name}": ${(err as Error).message}`);
          }
        }
      }
      const now = options.now ? options.now() : new Date();
      await syncTasks(storage, defs, now);
      // Restart recovery: cancel orphaned in-flight runs and release locks left
      // by the previous process (engine-level; before the loops start).
      await engine.recoverOrphanRuns(now);
      // R2: freeze the queue from process start — set after recovery so a raw
      // restart still cleans up orphans, and before engine.start() so the very
      // first tick cannot claim anything.
      if (startPaused) engine.pause(processStartedAt, { startPaused: true });
      engine.start();
      const syncIntervalMs = options.syncIntervalMs ?? 60_000;
      if (syncIntervalMs > 0) {
        syncTimer = setInterval(() => {
          void daemon.runSyncOnce();
        }, syncIntervalMs);
      }
    },
    async runSyncOnce() {
      await syncLoop();
    },
    stop() {
      if (syncTimer) clearInterval(syncTimer);
      syncTimer = null;
      engine.stop();
      if (adminServer) adminServer.close();
      // external storage is owned by the caller — only close the sqlite we created
      if (db) db.close();
    },
  };
  return daemon;

  /** Live tasks.json sync: reconcile, tolerate a broken file at runtime. */
  async function syncLoop(): Promise<void> {
    if (syncing) return; // non-reentrant: a slow file read must never stack
    syncing = true;
    try {
      const defs = await loadTasksJson(options.tasksPath);
      await syncTasks(storage, defs, options.now ? options.now() : new Date());
      // sync OK — reset the failure streak so the NEXT incident alerts again
      // (alerts dedupe to the first failure of a streak; without this reset a
      // sync that heals then breaks again would stay silent).
      consecutiveSyncFailures = 0;
    } catch (err) {
      // runtime sync failure (broken/missing file, storage unreachable) — log
      // and keep the last good state; fail-fast applies only to the startup
      // load in start(). The alerts channel gets a sync-failed event (prod
      // lesson 2026-08-24: a dead mongo pool meant silent non-scheduling — no
      // runs, so no run.failed alert could ever fire; sync health is the
      // scheduler's own heartbeat).
      const message = err instanceof Error ? err.message : String(err);
      consecutiveSyncFailures += 1;
      console.error(`sched: tasks.json sync skipped: ${message}`);
      if (alerts) {
        await alerts
          .handleEvent({ type: 'sync-failed', error: message, consecutiveFailures: consecutiveSyncFailures })
          .catch(() => {}); // alerts never throw — belt and braces
      }
    } finally {
      syncing = false;
    }
  }
}

/**
 * S3/Minio artifact reader (books-model proxy): streams `s3://bucket/key`
 * objects so a private bucket stays private. Reads are best-effort — a missing
 * object returns null → the API answers 404.
 */
async function createS3ArtifactReader(
  cfg: { endpoint: string; region?: string; forcePathStyle?: boolean; accessKeyId: string; secretAccessKey: string },
): Promise<import('@schedjs/admin-api').ArtifactReader> {
  const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region ?? 'us-east-1',
    forcePathStyle: cfg.forcePathStyle ?? true,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  return {
    async get(ref) {
      const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(ref);
      if (!m) return null;
      try {
        const obj = await client.send(new GetObjectCommand({ Bucket: m[1]!, Key: m[2]! }));
        const bytes = await obj.Body?.transformToByteArray();
        if (!bytes) return null;
        return { contentType: obj.ContentType ?? 'application/octet-stream', body: Buffer.from(bytes) };
      } catch {
        return null; // missing / denied / unreachable → 404 via the API
      }
    },
  };
}
