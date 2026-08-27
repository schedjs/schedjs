import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { AlertsConfig } from './alerts.js';
import { nextRun } from './cron.js';
import { parseSchedule } from './human.js';
import type { Schedule } from './human.js';
import type { Storage } from './storage.js';
import type { RetryPolicy, RunStatus, ScheduleRecord, TaskRecord } from './types.js';

/**
 * One entry of a tasks.json file — the desired-state contract.
 *
 * The schedule kind is explicit in the file (a keyed object, books-style):
 * `{ "cron": "0 9 * * *" }`, `{ "interval": "every 5 minutes" }`,
 * `{ "once": "tomorrow at noon" }`. Books parity: `timezone` may sit inside the
 * cron object and is hoisted to the entry's `tz`. `label`/`description` are
 * metadata for humans / the future admin UI — the engine ignores them.
 *
 * Schedule-as-entity (2026-08-18): a task declares ONE OR MORE schedules via
 * `schedules: [...]`, each with its own `data`/policy (books pain: one task,
 * N sellers — one schedule per seller). The legacy `schedule` key is REMOVED —
 * a file that still uses it fails at load with «use schedules: [...]».
 */
export interface TaskDefinition {
  name: string;
  /** Per-task runner selection. Default: 'http'. */
  runner?: string;
  /**
   * REMOVED (schedule-as-entity, decision 2026-08-18). The legacy single-
   * schedule key is cut: presence → fail-fast «use schedules: [...]». Kept in
   * the type so the rejection is explicit, not a silent ignore.
   */
  schedule?: ScheduleDef;
  /**
   * One or more schedule instances of this task. Each element is one firing
   * rule with its own data/policy. Omit (or empty array) → trigger-only task
   * (no cron — launched manually / from the API).
   *
   * NOTE (slice 1): the engine still drives the task's PRIMARY (first)
   * schedule until slice 2 moves the tick loop onto schedule rows — a
   * single-schedule task is bit-identical to v1; multi-schedule tasks store
   * all schedules but the engine fires the first until slice 2.
   */
  schedules?: ScheduleEntry[];
  /** IANA timezone. Default: 'UTC'. Applies to entries that don't set their own. */
  tz?: string;
  /** Runner-specific config, validated per runner at load time (fail fast). */
  config: Record<string, unknown>;
  /**
   * Task-level scheduling priority (default for entries that don't override;
   * slice 3 resolves entry ?? task). Higher runs first among due tasks.
   */
  priority?: number;
  /**
   * Task-level retry policy (default for entries that don't override; slice 3
   * resolves entry ?? task). On failure, retry up to `maxAttempts` total
   * attempts with `backoffMs` (× `multiplier` per retry).
   */
  retry?: RetryPolicy;
  /**
   * Run-deadline contract: force-termination timeout in ms from run start.
   * `-1` = never auto-terminate (only manual cancel); `> 0` = force-fail the
   * run after this many ms. Absent = `-1` — the safe default (never
   * auto-terminate); an explicit positive value opts into a force-fail
   * deadline.
   */
  timeoutMs?: number;
  label?: string;
  /**
   * Per-task status-alert routing override (see the root `alerts` block in
   * {@link TasksJsonFile}). Field-wise merge over the root config — the task
   * wins; arrays REPLACE (`on: []` = silence this task). A task `webhook`
   * override routes to THAT channel (multi-channel escape hatch).
   */
  alerts?: Partial<AlertsConfig>;
  description?: string;
}

/** The legacy single-schedule shape — rejected at load (use `schedules`). */
export type ScheduleDef =
  | { cron: string; timezone?: string }
  | { interval: string }
  | { once: string };

/** Per-schedule extras shared by every schedule kind in `schedules: [...]`. */
export interface ScheduleEntryBase {
  /** Run parameters — a schedule-fired run dispatches with THIS data (tenant params: idSeller, …). */
  data?: unknown;
  /** Tenant key (userId/orgId) — multi-tenancy from the first line. */
  externalId?: string;
  /** Idempotent upsert key — a second create with the same key updates, never duplicates. */
  dedupKey?: string;
  /** Schedule-level retry override (slice 3 resolves schedule ?? task). */
  retry?: RetryPolicy;
  /** Schedule-level priority override (slice 3 resolves schedule ?? task). Default: 0. */
  priority?: number;
}

export type ScheduleEntry = ScheduleEntryBase &
  ({ cron: string; timezone?: string } | { interval: string } | { once: string });

export interface TasksJsonFile {
  tasks: TaskDefinition[];
  /**
   * Optional per-runner sandbox ceilings — the runner-level `allowedTools`
   * (what each runner may ever run). Keys are runner names
   * (`process`/`docker`/`ssh`/`mcp`/`http`). A task whose `config.allowedTools`
   * is not a subset of its runner's ceiling fails at load.
   */
  runners?: Record<string, RunnerCeilings>;
  /**
   * Optional platform-level status alerts (webhook) — see createAlerts.
   * The daemon reads it exactly like `runners`; a programmatic
   * `createDaemon({ alerts })` option overrides the file.
   */
  alerts?: AlertsConfig;
}

/** Runner-level sandbox ceiling from the `runners` block of tasks.json. */
export interface RunnerCeilings {
  /** Tools this runner may ever run (exact or trailing-`*`; per-runner spec format). */
  allowedTools?: string[];
}

const SCHEDULE_KEYS = ['cron', 'interval', 'once'] as const;

class TasksJsonError extends Error {
  constructor(taskName: string, detail: string) {
    super(`tasks.json: task "${taskName}": ${detail}`);
    this.name = 'TasksJsonError';
  }
}

function fail(name: string, detail: string): never {
  throw new TasksJsonError(name, detail);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Resolve one `schedules` element into an engine Schedule + effective tz.
 * Validates: exactly one schedule key, key/value kind match, timezone only on
 * cron, no tz/timezone conflict, per-entry tenant fields (externalId/dedupKey)
 * and policy (retry/priority). `tz` is the entry's effective default (the
 * task's tz for declarative files, the API-supplied tz for imperative ones).
 */
function resolveEntry(taskName: string, tz: string | undefined, raw: unknown, now: Date): ParsedEntry {
  if (!isPlainObject(raw)) {
    fail(taskName, 'every schedules element must be an object with exactly one of "cron" | "interval" | "once"');
  }
  const sched = raw as Record<string, unknown>;

  const keys = SCHEDULE_KEYS.filter((k) => sched[k] !== undefined);
  if (keys.length !== 1) {
    fail(
      taskName,
      `schedules element must have exactly one of "cron" | "interval" | "once" (found ${keys.length === 0 ? 'none' : keys.join(', ')})`,
    );
  }
  const key = keys[0]!;
  const value = sched[key];
  if (!isNonEmptyString(value)) fail(taskName, `schedules.${key} must be a non-empty string`);

  let effectiveTz = tz ?? 'UTC';
  const innerTz = sched.timezone;
  if (innerTz !== undefined) {
    if (key !== 'cron') fail(taskName, 'timezone is only valid on cron schedules');
    if (!isNonEmptyString(innerTz)) fail(taskName, 'schedules.timezone must be a non-empty string');
    // r8 #4 F1: hoist, never conflict — the entry sets its own tz, so it wins
    // over the task/API default (docs 03.tasks § Schedule kinds: task tz
    // "applies to schedules that don't set their own").
    effectiveTz = innerTz;
  }

  const schedule = parseSchedule(value, { now, tz: effectiveTz });
  if (schedule.kind !== key) {
    fail(taskName, `schedule key "${key}" does not match value (parsed as ${schedule.kind})`);
  }

  const priority = sched.priority;
  if (priority !== undefined && (!isPositiveInt(priority) && priority !== 0)) {
    fail(taskName, 'schedules.priority must be a non-negative integer');
  }
  validateRetry(taskName, 'schedules.retry', sched.retry);
  const externalId = sched.externalId;
  if (externalId !== undefined && !isNonEmptyString(externalId)) {
    fail(taskName, 'schedules.externalId must be a non-empty string');
  }
  const dedupKey = sched.dedupKey;
  if (dedupKey !== undefined && !isNonEmptyString(dedupKey)) {
    fail(taskName, 'schedules.dedupKey must be a non-empty string');
  }

  return {
    schedule,
    tz: effectiveTz,
    data: sched.data ?? null,
    externalId: externalId ?? null,
    dedupKey: dedupKey ?? null,
    retry: (sched.retry as RetryPolicy | undefined) ?? null,
    // keep "unset" distinguishable from an explicit 0 — toSchedules / the API
    // materialize entry ?? task default, and 0 ?? task.priority would swallow
    // the inheritance (F1).
    priority: priority as number | undefined,
  };
}

/**
 * Validate ONE imperative schedule entry (admin `POST /schedules`): exactly one
 * of cron|interval|once, timezone rules, per-entry tenant fields and policy.
 * `tz` is the default effective tz (the API passes the task's tz).
 */
export function parseScheduleEntry(
  taskName: string,
  entry: unknown,
  options: { now: Date; tz?: string },
): ParsedEntry {
  return resolveEntry(taskName, options.tz, entry, options.now);
}

/** Fail-fast per-runner config validation at load time — a typo must not become silent failed runs. */
function validateConfig(def: TaskDefinition): void {
  if (!isPlainObject(def.config)) fail(def.name, 'config must be an object');

  const runner = def.runner ?? 'http';
  if (runner === 'http') {
    const { url, method, headers, timeoutMs, auth } = def.config as Record<string, unknown>;
    if (!isNonEmptyString(url)) fail(def.name, 'config.url is required (http runner)');
    if (method !== undefined && typeof method !== 'string') fail(def.name, 'config.method must be a string');
    if (headers !== undefined && !isPlainObject(headers)) fail(def.name, 'config.headers must be an object');
    if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      fail(def.name, 'config.timeoutMs must be a positive number');
    }
    if (auth !== undefined) {
      if (!isPlainObject(auth)) fail(def.name, 'config.auth must be an object');
      else {
        const { apiKey, header } = auth as Record<string, unknown>;
        if (!isNonEmptyString(apiKey)) fail(def.name, 'config.auth.apiKey is required (non-empty string)');
        if (header !== undefined && typeof header !== 'string') fail(def.name, 'config.auth.header must be a string');
      }
    }
  } else if (runner === 'docker') {
    const { image } = def.config as Record<string, unknown>;
    if (!isNonEmptyString(image)) fail(def.name, 'config.image is required (docker runner)');
  }
  // unknown runner names: no shape check — custom runner seam (embedded use).
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** Fail-fast validation of one retry policy object at any level (task or schedule entry). */
function validateRetry(taskName: string, field: string, retry: unknown): void {
  if (retry === undefined) return;
  if (!isPlainObject(retry)) fail(taskName, `${field} must be an object`);
  const { maxAttempts, backoffMs, multiplier } = retry as Record<string, unknown>;
  if (!isPositiveInt(maxAttempts)) fail(taskName, `${field}.maxAttempts must be a positive integer (total attempts budget)`);
  if (typeof backoffMs !== 'number' || !Number.isFinite(backoffMs) || backoffMs < 0) {
    fail(taskName, `${field}.backoffMs must be a non-negative number`);
  }
  if (multiplier !== undefined && (typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier < 1)) {
    fail(taskName, `${field}.multiplier must be >= 1 (1 = fixed backoff)`);
  }
}

/** Fail-fast validation of the task-level engine policy fields (priority / retry). */
function validateEnginePolicy(def: TaskDefinition): void {
  if (def.priority !== undefined && (!isPositiveInt(def.priority) && def.priority !== 0)) {
    fail(def.name, 'priority must be a non-negative integer');
  }
  validateRetry(def.name, 'retry', def.retry);
  const timeoutMs = def.timeoutMs;
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || (timeoutMs !== -1 && timeoutMs <= 0))) {
    fail(def.name, 'timeoutMs must be -1 (never auto-terminate) or a positive number of milliseconds');
  }
}

export function initialNextRun(schedule: Schedule, tz: string, now: Date): Date | null {
  switch (schedule.kind) {
    case 'cron':
      return nextRun(schedule.cron, now, { tz });
    case 'interval':
      return new Date(now.getTime() + schedule.ms);
    case 'once':
      return schedule.at;
  }
}

/** One validated `schedules` element — the unit toTasks / toSchedules build on. */
export interface ParsedEntry {
  schedule: Schedule;
  tz: string;
  data: unknown;
  externalId: string | null;
  dedupKey: string | null;
  retry: RetryPolicy | null;
  /** Effective priority: undefined = the entry does not override — inherits the task default at materialization (toSchedules / API). */
  priority: number | undefined;
}

/** One validated TaskDefinition — shared parse so toTasks and toSchedules agree. */
interface ParsedTask {
  name: string;
  runner: string;
  tz: string;
  config: Record<string, unknown>;
  priority: number;
  retry: RetryPolicy | null;
  timeoutMs: number | null;
  label: string | null;
  description: string | null;
  entries: ParsedEntry[];
}

/**
 * Eagerly validate one TaskDefinition (fail-fast: bad config fails here, not as
 * failed runs) and split it into the task view + per-schedule views.
 */
function parseTask(def: TaskDefinition, now: Date): ParsedTask {
  if (!isNonEmptyString(def.name)) fail('<unnamed>', 'name must be a non-empty string');
  // decision 2026-08-18: the legacy `schedule` key is CUT — consumers were only
  // test stands; migration of existing rows happens in the DB (v0.7), not here.
  if (def.schedule !== undefined) fail(def.name, 'schedule key is removed — use "schedules": [...]');

  const rawEntries = def.schedules ?? [];
  if (!Array.isArray(rawEntries)) fail(def.name, 'schedules must be an array');
  // schedule-shape validation first (matches the v1 ordering: a malformed
  // schedule surfaces before config errors).
  const entries = rawEntries.map((e) => resolveEntry(def.name, def.tz, e, now));

  validateConfig(def);
  validateEnginePolicy(def);

  return {
    name: def.name,
    runner: def.runner ?? 'http',
    tz: entries[0]?.tz ?? def.tz ?? 'UTC',
    config: def.config,
    priority: def.priority ?? 0,
    retry: def.retry ?? null,
    timeoutMs: def.timeoutMs ?? -1,
    label: def.label ?? null,
    description: def.description ?? null,
    entries,
  };
}

/**
 * Parse a tasks.json document into {@link TaskRecord}s with initial nextRunAt
 * computed from `now`. The task row carries the PRIMARY (first) schedule —
 * the engine drives it until slice 2 moves the tick loop onto schedule rows.
 * Validates the whole file eagerly — bad config fails here, not as failed runs.
 */
export function toTasks(defs: TaskDefinition[], now: Date): TaskRecord[] {
  const parsed = defs.map((def) => parseTask(def, now));
  // file-wide dedupKey uniqueness (fail-fast): two schedules claiming the same
  // upsert key would silently fight on write (UNIQUE constraint).
  const dedupKeys = new Map<string, string>();
  for (const p of parsed) {
    for (const e of p.entries) {
      if (e.dedupKey === null) continue;
      const owner = dedupKeys.get(e.dedupKey);
      if (owner !== undefined) {
        fail(p.name, `duplicate schedules.dedupKey "${e.dedupKey}" (also used by task "${owner}")`);
      }
      dedupKeys.set(e.dedupKey, p.name);
    }
  }
  return parsed.map((p) => {
    const primary = p.entries[0] ?? null;
    return {
      name: p.name,
      runner: p.runner,
      schedule: primary?.schedule ?? null,
      tz: p.tz,
      config: p.config,
      label: p.label,
      description: p.description,
      nextRunAt: primary === null ? null : initialNextRun(primary.schedule, primary.tz, now),
      lastRunAt: null,
      lockedAt: null,
      failCount: 0,
      priority: p.priority,
      retry: p.retry,
      retryCount: 0,
      lastRunId: null,
      timeoutMs: p.timeoutMs,
      paused: false,
      disabled: false,
      // file tasks are managed by tasks.json — sync may disable them on removal (r7 F1)
      fileManaged: true,
    };
  });
}

/**
 * Build the {@link ScheduleRecord}s a tasks.json document declares — the
 * schedule-as-entity view of the same validated defs (toTasks' sibling; call
 * toTasks first for eager whole-file validation).
 *
 * Deterministic ids (idempotent re-sync): a task with exactly ONE schedule gets
 * id = task name — the same id the v0.7 migration synthesizes, so a legacy DB
 * row's runtime state transfers by name (decision 2026-08-18); multiple
 * schedules get `${taskName}#${index}`.
 */
export function toSchedules(defs: TaskDefinition[], now: Date): ScheduleRecord[] {
  const out: ScheduleRecord[] = [];
  for (const def of defs) {
    const p = parseTask(def, now);
    const n = p.entries.length;
    p.entries.forEach((e, i) => {
      out.push({
        id: n === 1 ? p.name : `${p.name}#${i}`,
        taskName: p.name,
        schedule: e.schedule,
        tz: e.tz,
        data: e.data,
        externalId: e.externalId,
        dedupKey: e.dedupKey,
        nextRunAt: initialNextRun(e.schedule, e.tz, now),
        lastRunAt: null,
        lockedAt: null,
        failCount: 0,
        // effective policy materialized at sync (entry ?? task default) — a
        // single-schedule task carries the task's priority/retry onto its row,
        // so the engine + storage sort/retry identically on every adapter and
        // v1 ordering is preserved for migrated DBs (which copied task policy).
        priority: e.priority ?? p.priority,
        retry: e.retry ?? p.retry,
        retryCount: 0,
        lastRunId: null,
        paused: false,
        disabled: false,
        // file schedules are managed by tasks.json — sync disables them on removal
        fileManaged: true,
      });
    });
  }
  return out;
}

/** Read and parse a tasks.json file (path or file URL). */
export async function loadTasksJson(path: string): Promise<TaskDefinition[]> {
  const raw = await readFile(path, 'utf8');
  const doc = JSON.parse(raw) as TasksJsonFile;
  if (!Array.isArray(doc.tasks)) throw new Error('tasks.json: expected a "tasks" array');
  const names = new Set<string>();
  for (const t of doc.tasks) {
    if (!isPlainObject(t)) throw new Error('tasks.json: every task must be an object');
    if (names.has(t.name)) throw new Error(`tasks.json: duplicate task name "${t.name}"`);
    names.add(t.name);
  }
  return doc.tasks;
}

/**
 * Read ONLY the `runners` block (sync — `createDaemon` builds its runners
 * eagerly, before `start()` can await). Malformed entries throw a clear error;
 * an unreadable/missing file returns `{}` — `start()` surfaces the real load
 * error via `loadTasksJson`.
 */
export function readTasksJsonRunnersSync(path: string): Record<string, RunnerCeilings> {
  let doc: Partial<TasksJsonFile>;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8')) as Partial<TasksJsonFile>;
  } catch {
    return {}; // start() will surface the real load error
  }
  const runners = doc.runners ?? {};
  if (typeof runners !== 'object' || runners === null || Array.isArray(runners)) {
    throw new Error('tasks.json: "runners" must be an object keyed by runner name');
  }
  for (const [name, cfg] of Object.entries(runners)) {
    if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) {
      throw new Error(`tasks.json: runners.${name} must be an object`);
    }
    const tools = (cfg as RunnerCeilings).allowedTools;
    if (tools !== undefined && (!Array.isArray(tools) || tools.some((t) => typeof t !== 'string' || t.length === 0))) {
      throw new Error(`tasks.json: runners.${name}.allowedTools must be an array of non-empty strings`);
    }
  }
  return runners as Record<string, RunnerCeilings>;
}

/**
 * Read ONLY the `alerts` block (sync — mirrors `readTasksJsonRunnersSync`;
 * the daemon builds its alert channel eagerly, before `start()` can await).
 * A missing file or a file without an `alerts` key returns `undefined`; a
 * present-but-malformed block (not an object) throws.
 */
export function readTasksJsonAlertsSync(path: string): AlertsConfig | undefined {
  let doc: Partial<TasksJsonFile>;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8')) as Partial<TasksJsonFile>;
  } catch {
    return undefined; // start() will surface the real load error
  }
  const alerts = doc.alerts;
  if (alerts === undefined) return undefined;
  if (typeof alerts !== 'object' || alerts === null || Array.isArray(alerts)) {
    throw new Error('tasks.json: "alerts" must be an object');
  }
  return alerts as AlertsConfig;
}

const TERMINAL_STATUSES: RunStatus[] = ['succeeded', 'failed', 'cancelled'];

function validateTaskAlertsBlock(taskName: string, alerts: unknown): void {
  if (!isPlainObject(alerts)) {
    fail(taskName, 'alerts must be an object');
  }
  const block = alerts as Record<string, unknown>;
  if (block.on !== undefined) {
    if (!Array.isArray(block.on) || block.on.some((s) => !TERMINAL_STATUSES.includes(s as RunStatus))) {
      fail(
        taskName,
        `alerts.on must be an array of terminal statuses (${TERMINAL_STATUSES.join(', ')}), got ${JSON.stringify(block.on)}`,
      );
    }
  }
  if (block.onMissed !== undefined && typeof block.onMissed !== 'boolean') {
    fail(taskName, `alerts.onMissed must be a boolean, got ${JSON.stringify(block.onMissed)}`);
  }
  if (block.webhook !== undefined) {
    if (!isPlainObject(block.webhook) || typeof (block.webhook as Record<string, unknown>).url !== 'string') {
      fail(taskName, `alerts.webhook must be an object with a string "url", got ${JSON.stringify(block.webhook)}`);
    }
  }
}

/**
 * Read ONLY the per-task `alerts` blocks (sync — mirrors the other two
 * readers; the daemon folds them into the alerts config before `start()`).
 * Returns a map keyed by task name (a task without an `alerts` block is
 * absent — root defaults apply). A missing file returns `{}`; a present-but-
 * malformed block (non-object, bad `on`/`onMissed`/`webhook` shape) throws
 * fail-fast — a typo like `on: ["fail"]` must not silently disable alerts.
 */
export function readTasksJsonTaskAlertsSync(path: string): Record<string, Partial<AlertsConfig>> {
  let doc: Partial<TasksJsonFile>;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8')) as Partial<TasksJsonFile>;
  } catch {
    return {}; // start() will surface the real load error
  }
  const tasks = doc.tasks ?? [];
  if (!Array.isArray(tasks)) return {}; // loadTasksJson reports the real shape error
  const out: Record<string, Partial<AlertsConfig>> = {};
  for (const task of tasks as TaskDefinition[]) {
    const alerts = task.alerts;
    if (alerts === undefined) continue;
    validateTaskAlertsBlock(task.name, alerts);
    out[task.name] = alerts;
  }
  return out;
}

/**
 * Apply one validated TaskRecord to storage with syncTasks semantics: create
 * when absent; on upsert update runner/schedule/tz/config/priority/retry/
 * timeoutMs/label/description while preserving runtime state (nextRunAt kept
 * unless the schedule changed, lockedAt/failCount/paused/retryCount/disabled
 * untouched). Returns the stored record.
 */
async function applyTask(storage: Storage, task: TaskRecord): Promise<TaskRecord> {
  const existing = await storage.getTask(task.name);
  if (!existing) {
    await storage.upsertTask(task);
    return task;
  }
  const scheduleChanged =
    JSON.stringify(existing.schedule) !== JSON.stringify(task.schedule) || existing.tz !== task.tz;
  const merged = {
    ...existing,
    runner: task.runner,
    schedule: task.schedule,
    tz: task.tz,
    config: task.config,
    priority: task.priority,
    retry: task.retry,
    timeoutMs: task.timeoutMs ?? null,
    label: task.label,
    description: task.description,
    nextRunAt: scheduleChanged ? task.nextRunAt : existing.nextRunAt,
  };
  await storage.upsertTask(merged);
  return merged;
}

/**
 * Apply one ScheduleRecord with syncTasks semantics — the schedule twin of
 * {@link applyTask}: create when absent; on upsert update the declarative
 * fields while preserving runtime state (nextRunAt kept unless the firing rule
 * or tz changed; lockedAt/failCount/paused/retryCount/disabled untouched).
 */
async function applySchedule(storage: Storage, schedule: ScheduleRecord): Promise<void> {
  const existing = await storage.getSchedule(schedule.id);
  if (!existing) {
    await storage.createSchedule(schedule);
    return;
  }
  const scheduleChanged =
    JSON.stringify(existing.schedule) !== JSON.stringify(schedule.schedule) || existing.tz !== schedule.tz;
  await storage.createSchedule({
    ...existing,
    schedule: schedule.schedule,
    tz: schedule.tz,
    data: schedule.data,
    externalId: schedule.externalId,
    dedupKey: schedule.dedupKey,
    priority: schedule.priority,
    retry: schedule.retry,
    nextRunAt: scheduleChanged ? schedule.nextRunAt : existing.nextRunAt,
  });
}

/**
 * Runtime registration (admin `POST /tasks` / `POST /tasks/:name/schedule`):
 * validate one TaskDefinition eagerly (toTasks — fail-fast, tasks.json parity)
 * and apply it with {@link applyTask} semantics, plus any schedules the
 * definition declares (runtime-owned, never disabled by sync). Returns the
 * stored TaskRecord.
 */
export async function upsertTaskDefinition(storage: Storage, def: TaskDefinition, now: Date): Promise<TaskRecord> {
  // toTasks([def]) always yields exactly one record for a valid definition
  const task = toTasks([def], now)[0]!;
  // runtime registration is NOT file-managed — sync never disables it (r7 F1)
  task.fileManaged = false;
  const applied = await applyTask(storage, task);
  for (const sched of toSchedules([def], now)) {
    await applySchedule(storage, { ...sched, fileManaged: false });
  }
  return applied;
}

/**
 * Reconciler-lite: bring the storage in line with the desired tasks.json state.
 * Tasks AND their schedules are created/updated; entries REMOVED from the file
 * (tasks or schedules) are disabled — kept in history, never tick again — the
 * documented contract (docs/03.tasks.md § Sync semantics). Runtime state
 * (nextRunAt, lockedAt, failCount, paused) is preserved unless the schedule
 * actually changed — then nextRunAt recomputes from `now`. `disabled` is
 * flip-only-on-removal: a schedule disabled by the operator or a previous
 * removal is never re-enabled by sync.
 */
export async function syncTasks(storage: Storage, defs: TaskDefinition[], now: Date): Promise<void> {
  const tasks = toTasks(defs, now); // eager validation of the whole file (fail-fast)
  const schedules = toSchedules(defs, now);
  const desired = new Set(tasks.map((t) => t.name));
  for (const task of tasks) {
    await applyTask(storage, task);
  }
  for (const sched of schedules) {
    await applySchedule(storage, sched);
  }
  // remove-from-file → disabled: a zombie task must not keep ticking silently.
  // Re-adding it to tasks.json keeps it disabled (enable via taskOps) — sync
  // never flips `disabled` back, so operator intent is never overwritten.
  const existing = await storage.listTasks();
  for (const t of existing) {
    // r7 F1: only file-managed tasks are disabled on removal — a task registered
    // at runtime (POST /tasks, fileManaged=false) is never touched by sync.
    if (!desired.has(t.name) && t.fileManaged !== false && !t.disabled) {
      await storage.upsertTask({ ...t, disabled: true });
    }
  }
  // same contract for schedules: removed from the file → disabled (file-managed
  // only; runtime-registered schedules survive sync).
  const desiredSchedIds = new Set(schedules.map((s) => s.id));
  const existingSchedules = await storage.listSchedules();
  for (const s of existingSchedules) {
    if (!desiredSchedIds.has(s.id) && s.fileManaged !== false && !s.disabled) {
      await storage.updateSchedule(s.id, { disabled: true });
    }
  }
}
