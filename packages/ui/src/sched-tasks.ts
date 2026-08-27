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
      this.hasMore = body.tasks.length > limit;
      this.tasks = pageRows(body.tasks, limit);
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
                    <td>${t.failCount}</td>
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
