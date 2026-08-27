#!/usr/bin/env node
/**
 * @schedjs/cli — operator CLI for sched (bin: `sched`). A thin projection of
 * the admin REST API: status/runs/tasks/schedules/trigger/pause/resume plus
 * check-worker (wire-protocol conformance). Zero dependencies (node:fetch).
 *
 * Exit codes: 0 ok / 1 api·network·data error / 2 usage. `--json` is the
 * stable machine contract; tables are for TTY eyes only.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AdminApiClient, AdminApiError } from './client.js';
import { checkWorker, renderVerdict, type ScenarioResult } from './check-worker.js';
import { field, formatTable, humanDuration, shortTime } from './table.js';

const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const DEFAULT_ADMIN_URL = 'http://127.0.0.1:8080/api';

/** Runs filter status enum (F4) — mirrors RunStatus in @schedjs/core. */
const RUN_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);

/** Set by main() — lets the error handler keep --json a machine contract (F7). */
let jsonMode = false;

/** Effective pause state of a schedule row (F5): task-level hold is visible. */
function effectivePaused(s: Record<string, unknown>): string {
  if (s.effectiveStatus === 'paused-task') return 'yes (task)';
  return s.paused ? 'yes' : 'no';
}

const USAGE = `sched v${VERSION} — operator CLI for sched (admin API client)

Usage: sched <command> [args] [--admin-url URL] [--api-key KEY] [--json]

Commands:
  status                 daemon health + task/schedule/run counts + next runs
  runs [--task T] [--status S] [--limit N] [--offset N]
                         list runs (newest first); filters are forwarded to the API
  tasks                  list tasks
  schedules              list schedules
  trigger <task> [--data JSON]
                         fire a task ad-hoc (manual run)
  pause <task> | pause --schedule <id>
  resume <task> | resume --schedule <id>
  check-worker <url> [--api-key KEY] [--timeout SECONDS]
                         conformance-validate an HTTP envelope worker (6 scenarios)

Global flags:
  --admin-url URL        admin API base (env: SCHED_ADMIN_URL, default ${DEFAULT_ADMIN_URL})
  --api-key KEY          admin bearer key (env: SCHED_ADMIN_KEY)
  --json                 machine-readable output (stable JSON contract)
  -h, --help             show this help
  -v, --version          show version

Exit codes: 0 ok / 1 api, network or data error / 2 usage.

Examples:
  sched status
  sched runs --status failed --limit 20 --json
  sched trigger sync-seller --data '{"idSeller":2}'
  sched pause --schedule sch-123
  sched check-worker http://127.0.0.1:8081 --api-key $SCHED_API_KEY

(daemon ships as \`schedd\`; the admin api mounts at /api — the default
--admin-url already includes it. PowerShell 5.1: use pwsh or chcp 65001 for
UTF-8 JSON pipes.)`;

class UsageError extends Error {}

interface GlobalOpts {
  adminUrl: string;
  apiKey: string | undefined;
  json: boolean;
  help: boolean;
  version: boolean;
}

/** Extract global flags from argv; everything else → [command, ...args]. */
function parseGlobal(argv: string[]): { global: GlobalOpts; command: string | undefined; rest: string[] } {
  const global: GlobalOpts = {
    adminUrl: process.env.SCHED_ADMIN_URL ?? DEFAULT_ADMIN_URL,
    apiKey: process.env.SCHED_ADMIN_KEY,
    json: false,
    help: false,
    version: false,
  };
  const rest: string[] = [];
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '--admin-url': {
        const v = argv[++i];
        if (v === undefined) throw new UsageError('missing value for --admin-url');
        global.adminUrl = v;
        break;
      }
      case '--api-key': {
        // Before the command → global admin key. After it: only check-worker
        // gets a command-scoped --api-key (its worker secret); other commands
        // still treat a trailing --api-key as the admin key.
        const v = argv[++i];
        if (v === undefined) throw new UsageError('missing value for --api-key');
        if (command === undefined || command !== 'check-worker') {
          global.apiKey = v;
        } else {
          rest.push(a, v);
        }
        break;
      }
      case '--json':
        global.json = true;
        break;
      case '-h':
      case '--help':
        global.help = true;
        break;
      case '-v':
      case '--version':
        global.version = true;
        break;
      default:
        rest.push(a);
        if (command === undefined) command = a;
    }
  }
  // --admin-url must be a valid http(s) endpoint — catch typos early (exit 2).
  try {
    const u = new URL(global.adminUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
  } catch {
    throw new UsageError(`--admin-url: invalid URL '${global.adminUrl}' (expected http(s)://host[:port][/api])`);
  }
  const commandArgs = command === undefined ? rest : rest.slice(1);
  return { global, command, rest: commandArgs };
}

type FlagType = 'string' | 'boolean';
type FlagSpec = Record<string, FlagType>;

/** Minimal per-command flag parser. Unknown flag / missing value → UsageError. */
function parseCommandArgs(args: string[], spec: FlagSpec): { values: Record<string, string | boolean>; positionals: string[] } {
  const values: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(0, eq) : a;
      const def = spec[name];
      if (!def) throw new UsageError(`unknown option '${name}'`);
      if (def === 'boolean') {
        if (eq >= 0) throw new UsageError(`option '${name}' does not take a value`);
        values[name] = true;
      } else {
        const v = eq >= 0 ? a.slice(eq + 1) : args[++i];
        if (v === undefined) throw new UsageError(`missing value for ${name}`);
        values[name] = v;
      }
    } else {
      positionals.push(a);
    }
  }
  return { values, positionals };
}

function printJson(body: unknown): void {
  process.stdout.write(JSON.stringify(body, null, 2) + '\n');
}

async function cmdStatus(client: AdminApiClient, json: boolean): Promise<void> {
  const [health, tasks, schedules] = await Promise.all([client.health(), client.listTasks(), client.listSchedules()]);
  const failedRuns = await client.listRuns({ status: 'failed', limit: 100 });
  const now = Date.now();
  const nextRuns = schedules
    .filter((s) => typeof s.nextRunAt === 'string')
    .sort((a, b) => new Date(a.nextRunAt as string).getTime() - new Date(b.nextRunAt as string).getTime())
    .slice(0, 5)
    .map((s) => ({ id: s.id, taskName: s.taskName, nextRunAt: s.nextRunAt }));
  if (json) {
    printJson({
      ok: health.ok,
      version: health.version,
      uptimeMs: health.uptimeMs,
      tasks: tasks.length,
      schedules: schedules.length,
      failedRuns: failedRuns.length,
      nextRuns,
    });
    return;
  }
  process.stdout.write(
    `sched: daemon alive — version ${health.version}, uptime ${humanDuration(health.uptimeMs)}\n` +
      `tasks ${tasks.length} | schedules ${schedules.length} | failed runs (last 100) ${failedRuns.length}\n`,
  );
  if (nextRuns.length > 0) {
    process.stdout.write('next runs:\n');
    process.stdout.write(formatTable(['ID', 'TASK', 'NEXT RUN'], nextRuns.map((s) => [String(s.id), String(s.taskName), shortTime(s.nextRunAt as string)])) + '\n');
  }
}

async function cmdRuns(client: AdminApiClient, args: string[], json: boolean): Promise<void> {
  const { values, positionals } = parseCommandArgs(args, {
    '--task': 'string',
    '--status': 'string',
    '--limit': 'string',
    '--offset': 'string',
  });
  if (positionals.length > 0) throw new UsageError(`runs: unexpected argument '${positionals[0]}'`);
  const filter: { task?: string; status?: string; limit?: number; offset?: number } = {};
  if (typeof values['--task'] === 'string') filter.task = values['--task'];
  if (typeof values['--status'] === 'string') {
    // F4 (CLI-F&F): validate the status enum — a typo must not silently return an empty list.
    if (!RUN_STATUSES.has(values['--status'])) {
      throw new UsageError(`runs: --status must be one of ${[...RUN_STATUSES].join('|')} (got '${values['--status']}')`);
    }
    filter.status = values['--status'];
  }
  for (const key of ['--limit', '--offset'] as const) {
    if (typeof values[key] !== 'string') continue;
    const n = Number(values[key]);
    if (!Number.isInteger(n) || n < 0) {
      throw new UsageError(`runs: ${key} must be a non-negative integer (got '${values[key]}')`);
    }
    if (key === '--limit') filter.limit = n;
    else filter.offset = n;
  }
  const runs = await client.listRuns(filter);
  if (json) {
    printJson({ runs });
    return;
  }
  if (runs.length === 0) {
    process.stdout.write('no runs\n');
    return;
  }
  process.stdout.write(
    formatTable(
      ['ID', 'TASK', 'STATUS', 'STARTED'],
      runs.map((r) => [field(r, 'id'), field(r, 'taskName'), field(r, 'status'), shortTime(r.startedAt as string)]),
    ) + '\n',
  );
}

async function cmdTasks(client: AdminApiClient, json: boolean): Promise<void> {
  const tasks = await client.listTasks();
  if (json) {
    printJson({ tasks });
    return;
  }
  if (tasks.length === 0) {
    process.stdout.write('no tasks\n');
    return;
  }
  process.stdout.write(
    formatTable(
      ['NAME', 'RUNNER', 'PRIORITY', 'PAUSED', 'NEXT RUN'],
      tasks.map((t) => [field(t, 'name'), field(t, 'runner'), field(t, 'priority'), t.paused ? 'yes' : 'no', shortTime(t.nextRunAt as string)]),
    ) + '\n',
  );
}

async function cmdSchedules(client: AdminApiClient, json: boolean): Promise<void> {
  const schedules = await client.listSchedules();
  if (json) {
    printJson({ schedules });
    return;
  }
  if (schedules.length === 0) {
    process.stdout.write('no schedules\n');
    return;
  }
  process.stdout.write(
    formatTable(
      ['ID', 'TASK', 'NEXT RUN', 'PAUSED'],
      // F5 (CLI-F&F): a task-level pause must be visible — the API resolves
      // effectiveStatus ('paused-task' | 'paused-schedule' | 'active'); the raw
      // `paused` flag alone hides a family stop held by the task.
      schedules.map((s) => [field(s, 'id'), field(s, 'taskName'), shortTime(s.nextRunAt as string), effectivePaused(s)]),
    ) + '\n',
  );
}

async function cmdTrigger(client: AdminApiClient, args: string[], json: boolean): Promise<void> {
  const { values, positionals } = parseCommandArgs(args, { '--data': 'string' });
  if (positionals.length === 0) throw new UsageError('trigger: missing <task>');
  if (positionals.length > 1) throw new UsageError(`trigger: unexpected argument '${positionals[1]}'`);
  let data: unknown;
  if (typeof values['--data'] === 'string') {
    try {
      data = JSON.parse(values['--data']);
    } catch {
      throw new UsageError('trigger: --data must be valid JSON');
    }
  }
  const run = await client.triggerTask(positionals[0]!, data);
  if (json) {
    printJson({ run });
    return;
  }
  process.stdout.write(`triggered ${positionals[0]}: run ${field(run, 'id')} (${field(run, 'status')})\n`);
}

async function cmdPauseResume(client: AdminApiClient, command: 'pause' | 'resume', args: string[], json: boolean): Promise<void> {
  const { values, positionals } = parseCommandArgs(args, { '--schedule': 'string' });
  const scheduleId = typeof values['--schedule'] === 'string' ? values['--schedule'] : undefined;
  const name = positionals[0];
  if (scheduleId !== undefined) {
    if (positionals.length > 0) throw new UsageError(`${command}: cannot combine <task> and --schedule`);
    if (command === 'pause') await client.pauseSchedule(scheduleId);
    else await client.resumeSchedule(scheduleId);
    if (json) printJson({ ok: true, kind: 'schedule', id: scheduleId });
    else process.stdout.write(`schedule ${scheduleId} ${command}d\n`);
    return;
  }
  if (name === undefined) throw new UsageError(`${command}: missing <task> (or --schedule <id>)`);
  if (command === 'pause') await client.pauseTask(name);
  else await client.resumeTask(name);
  if (json) printJson({ ok: true, kind: 'task', name });
  else process.stdout.write(`task ${name} ${command}d\n`);
}

async function cmdCheckWorker(args: string[], json: boolean): Promise<void> {
  const { values, positionals } = parseCommandArgs(args, {
    '--api-key': 'string',
    '--timeout': 'string',
  });
  const url = positionals[0];
  if (url === undefined) throw new UsageError('check-worker <url> — missing worker URL');
  if (positionals.length > 1) throw new UsageError(`check-worker: unexpected argument '${positionals[1]}'`);
  let urlOk: URL;
  try {
    urlOk = new URL(url);
  } catch {
    throw new UsageError(`check-worker: invalid URL '${url}'`);
  }
  const timeoutS = typeof values['--timeout'] === 'string' ? Number(values['--timeout']) : 30;
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) throw new UsageError('check-worker: --timeout must be a positive number of seconds');
  const apiKey = typeof values['--api-key'] === 'string' ? values['--api-key'] : undefined;
  const result = await checkWorker({
    url: urlOk.toString(),
    apiKey,
    timeoutMs: timeoutS * 1000,
    pollDeadlineMs: timeoutS * 1000,
  });
  if (json) {
    printJson({
      ok: result.ok,
      pass: result.scenarios.filter((s) => s.pass).length,
      fail: result.scenarios.filter((s) => !s.pass).length,
      scenarios: result.scenarios.map((s: ScenarioResult) => ({ name: s.name, pass: s.pass, skipped: s.skipped ?? false, detail: s.detail })),
    });
  } else {
    process.stdout.write(renderVerdict(urlOk.toString(), result.scenarios) + '\n');
  }
  if (!result.ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  const { global, command, rest } = parseGlobal(process.argv.slice(2));
  jsonMode = global.json;
  if (global.help) {
    process.stdout.write(USAGE + '\n');
    return;
  }
  if (global.version) {
    process.stdout.write(`sched v${VERSION}\n`);
    return;
  }
  if (command === undefined) {
    process.stderr.write(`sched: missing command\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const client = new AdminApiClient(global.adminUrl, global.apiKey);
  switch (command) {
    case 'status':
      await cmdStatus(client, global.json);
      break;
    case 'runs':
      await cmdRuns(client, rest, global.json);
      break;
    case 'tasks':
      await cmdTasks(client, global.json);
      break;
    case 'schedules':
      await cmdSchedules(client, global.json);
      break;
    case 'trigger':
      await cmdTrigger(client, rest, global.json);
      break;
    case 'pause':
    case 'resume':
      await cmdPauseResume(client, command, rest, global.json);
      break;
    case 'check-worker':
      await cmdCheckWorker(rest, global.json);
      break;
    default:
      process.stderr.write(`sched: unknown command '${command}'\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

main().catch((err: unknown) => {
  const message =
    err instanceof UsageError
      ? err.message
      : err instanceof AdminApiError
        ? `${err.message} (HTTP ${err.status})`
        : err instanceof Error
          ? err.message
          : String(err);
  const code = err instanceof UsageError ? 2 : 1;
  if (jsonMode) {
    // F7 (CLI-F&F): --json is the machine contract — errors must be JSON too,
    // or `| jq` pipelines break on any failure.
    printJson({ ok: false, error: message, exitCode: code });
  } else if (err instanceof UsageError) {
    process.stderr.write(`sched: ${err.message}\n\n${USAGE}`);
  } else if (err instanceof AdminApiError) {
    process.stderr.write(`sched: ${err.message} (HTTP ${err.status})\n`);
  } else {
    process.stderr.write(`sched: ${message}\n`);
  }
  process.exitCode = code;
});

// EPIPE: `sched runs --json | head` must not crash — exit cleanly (exit 0).
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});
