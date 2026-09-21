import { LitElement, html } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import type { TaskRecord } from '@schedjs/core';
import { apiGet, apiSend } from './api.js';
import { PageSize, pagerControls, pageRows } from './pager.js';
import { shared } from './styles.js';


const fmt = (d: string | null): string => (d ? new Date(d).toLocaleString() : '—');

/** Last-run outcome badge (r6 F10): how the most recent run ended. */
const statusOf = (s: string | null): string => {
  if (s === 'succeeded') return '✔ succeeded';
  if (s === 'failed') return '✘ failed';
  if (s === 'cancelled') return '⊘ cancelled';
  return '—';
};

/** GET /tasks items — TaskRecord + the server-resolved lastRunStatus (r6 F10). */
type TaskRow = TaskRecord & { lastRunStatus: string | null };

/** GET /schedules items — the fields the FAILS aggregation and the sweep guard read. */
type ScheduleFailRow = { id?: unknown; taskName?: unknown; failCount?: unknown };

/**
 * Page size of the FAILS sweep — the storage cap (`listSchedules` clamps to
 * 1000), so one request per 1000 rows.
 */
const SCHEDULES_PAGE = 1000;
/** Sweep ceiling — the hard backstop behind the repeated-page check below. */
const SCHEDULES_MAX_PAGES = 1000;

/**
 * Every schedule row, paged (R1 follow-up — the sweep `sched tasks` does).
 * `GET /schedules` caps one response server-side (default 100, storage cap
 * 1000), so a single request silently truncates a longer board and a per-task
 * total would come out too small. The loop takes page-size chunks until a short
 * page; an exact multiple of the page size costs one extra (empty) request,
 * which is cheaper than a wrong number.
 *
 * A board that mutates while the sweep runs can shift the offset window (rows
 * are ordered by id) — the total is a near-snapshot, not a transaction, exactly
 * as in the CLI. A server that ignores `offset` is caught on the second page
 * (same leading id) instead of after 1000 full round trips on a 5 s poll; the
 * page ceiling stays as a backstop for a server that ignores it in some other
 * way.
 */
async function listAllSchedules(base: string, token?: string): Promise<ScheduleFailRow[]> {
  const all: ScheduleFailRow[] = [];
  let prevFirstId: unknown;
  for (let page = 0; ; page += 1) {
    const body = (await apiGet(
      base,
      `/schedules?limit=${SCHEDULES_PAGE}&offset=${page * SCHEDULES_PAGE}`,
      token,
    )) as { schedules?: ScheduleFailRow[] } | null;
    const rows = body?.schedules;
    if (!Array.isArray(rows)) {
      throw new Error('schedules response carried no schedules array — cannot total the FAILS column');
    }
    // Dedup is impossible across a moved window, but a *repeated* first id means
    // `offset` was ignored: page N is page N-1, and looping would never end.
    const firstId = rows[0]?.id;
    if (prevFirstId !== undefined && firstId === prevFirstId) {
      throw new Error(
        `schedules page ${page} repeats page ${page - 1} — the admin api ignored offset (daemon older than pagination?)`,
      );
    }
    prevFirstId = firstId;
    all.push(...rows);
    if (rows.length < SCHEDULES_PAGE) return all;
    if (page + 1 >= SCHEDULES_MAX_PAGES) {
      throw new Error(
        `schedules list did not converge after ${SCHEDULES_MAX_PAGES} pages — the admin api ignored limit/offset (daemon older than pagination?)`,
      );
    }
  }
}

/** taskName → Σ `schedule.failCount` — the half of the total that never lands on the task row. */
function scheduleFailSums(schedules: ScheduleFailRow[]): Map<string, number> {
  const byTask = new Map<string, number>();
  for (const s of schedules) {
    const name = typeof s.taskName === 'string' ? s.taskName : '';
    const count = typeof s.failCount === 'number' ? s.failCount : 0;
    // Negative / NaN / fractional counts are not a number this column can
    // total: skipping beats poisoning the sum (a NaN total prints as a dash,
    // i.e. "nothing is red" — the exact lie the column exists to prevent).
    if (name === '' || !Number.isInteger(count) || count <= 0) continue;
    byTask.set(name, (byTask.get(name) ?? 0) + count);
  }
  return byTask;
}

/**
 * FAILS cell — the task's cumulative failed completions: the task row (manual
 * `triggerTask`/`retryRun`) **plus its schedule rows**, because a schedule-fired
 * run advances the schedule (`engine.completeScheduleRun` →
 * `storage.completeSchedule`) and a cron task's own `failCount` stays 0 forever
 * — the raw field is dead on exactly the boards this column exists for. Same
 * rule as `sched tasks` (task:3103); zero prints as an em dash there and here,
 * so a board of dashes reads "nothing is red" at a glance. This is NOT the
 * failure streak — that lives in the daemon process (see Logging → alerts).
 */
function failsCell(task: TaskRow, scheduleFails: Map<string, number>): string {
  const total = task.failCount + (scheduleFails.get(task.name) ?? 0);
  return total > 0 ? String(total) : '—';
}

/**
 * `<sched-tasks base="/api" token="…">` — task list with run/pause/resume
 * actions against the admin api. Polls every `refreshMs` so next-run times
 * and fail counts stay live. Pagination footer: prev/next + page-size select
 * (10/25/50/100); changing the size resets the offset.
 */
export class SchedTasks extends LitElement {
  static styles = [shared];

  static properties = {
    base: { type: String },
    token: { type: String },
    /** Auto-refresh interval in ms. 0 → no polling. Default: 5000. */
    refreshMs: { type: Number, attribute: 'refresh-ms' },
    /** Page size (footer select: 10/25/50/100). Default: 50. */
    limit: { type: Number },
    /** Current page offset. Changing it reloads. */
    offset: { type: Number },
  };

  declare base: string;
  declare token?: string;
  declare refreshMs: number;
  declare limit: number;
  declare offset: number;

  constructor() {
    super();
    this.base = '/api';
    this.refreshMs = 5000;
    this.limit = 50;
    this.offset = 0;
  }

  private tasks: TaskRow[] = [];
  /** taskName → Σ schedule.failCount, refreshed with every load (see `failsCell`). */
  private scheduleFails = new Map<string, number>();
  private error = '';
  private busy = false;
  private hasMore = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  connectedCallback() {
    super.connectedCallback();
    void this.load();
    if (this.refreshMs > 0) {
      this.timer = setInterval(() => void this.load(), this.refreshMs);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.timer) clearInterval(this.timer);
  }

  private async load(): Promise<void> {
    try {
      const limit = this.limit ?? 50;
      const offset = this.offset ?? 0;
      // probe one extra row so the footer can tell whether a next page exists
      const body = (await apiGet(this.base, `/tasks?limit=${limit + 1}&offset=${offset}`, this.token)) as {
        tasks: TaskRow[];
      };
      const hasMore = body.tasks.length > limit;
      const tasks = pageRows(body.tasks, limit);
      // The FAILS column needs the schedule rows of the tasks on this page. Read
      // them before committing any state: a half-read snapshot (fresh rows, the
      // previous sweep) would print a number that is wrong rather than absent.
      // An empty board skips the sweep entirely, like the CLI's early return.
      const scheduleFails =
        tasks.length === 0 ? new Map<string, number>() : scheduleFailSums(await listAllSchedules(this.base, this.token));
      this.hasMore = hasMore;
      this.tasks = tasks;
      this.scheduleFails = scheduleFails;
      this.error = '';
      this.requestUpdate();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.requestUpdate();
    }
  }

  private async act(name: string, action: 'run' | 'pause' | 'resume'): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await apiSend(this.base, `/tasks/${encodeURIComponent(name)}/${action}`, this.token, 'POST');
      await this.load();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.requestUpdate();
    } finally {
      this.busy = false;
    }
  }

  private onPrev(): void {
    if (this.offset <= 0) return;
    this.offset -= this.limit;
    void this.load();
  }

  private onNext(): void {
    if (!this.hasMore) return;
    this.offset += this.limit;
    void this.load();
  }

  /** Page size change resets the offset to the first page. */
  private onLimitChange(n: PageSize): void {
    if (n === this.limit) return;
    this.limit = n;
    this.offset = 0;
    void this.load();
  }

  render() {
    return html`
      <div class="head">
        <span class="title">Tasks</span>
        <span class="muted">${this.tasks.length}</span>
        <span class="spacer"></span>
        <button class="btn" @click=${() => void this.load()}>refresh</button>
      </div>
      ${this.error ? html`<div class="err">${this.error}</div>` : ''}
      <table>
        <thead><tr><th>name</th><th>runner</th><th>schedule</th><th>next run</th><th>fails</th><th>last status</th><th>state</th><th></th></tr></thead>
        <tbody>
          ${this.tasks.length === 0
            ? html`<tr><td colspan="8" class="empty">no tasks</td></tr>`
            : repeat(
                this.tasks,
                (t) => t.name,
                (t) => html`
                  <tr>
                    <td>${t.name}</td>
                    <td class="muted">${t.runner}</td>
                    <td class="muted">${JSON.stringify(t.schedule)}</td>
                    <td>${fmt(t.nextRunAt as unknown as string)}</td>
                    <td>${failsCell(t, this.scheduleFails)}</td>
                    <td>${statusOf(t.lastRunStatus)}</td>
                    <td>${t.paused ? '⏸ paused' : t.disabled ? '⛔ disabled' : '▶ active'}</td>
                    <td>
                      <button class="btn" @click=${() => void this.act(t.name, 'run')}>run</button>
                      ${t.paused
                        ? html`<button class="btn" @click=${() => void this.act(t.name, 'resume')}>resume</button>`
                        : html`<button class="btn" @click=${() => void this.act(t.name, 'pause')}>pause</button>`}
                    </td>
                  </tr>
                `,
              )}
        </tbody>
      </table>
      ${pagerControls(
        { offset: this.offset ?? 0, limit: (this.limit ?? 50) as PageSize, hasMore: this.hasMore ?? false },
        this.tasks.length,
        { onPrev: () => this.onPrev(), onNext: () => this.onNext(), onLimit: (n) => this.onLimitChange(n) },
      )}
    `;
  }
}
