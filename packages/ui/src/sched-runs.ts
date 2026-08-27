import { LitElement, css, html } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import type { RunRecord } from '@schedjs/core';
import { apiGet, apiSend } from './api.js';
import { PageSize, pagerControls, pageRows } from './pager.js';
import { shared } from './styles.js';
import './sched-status.js';


const fmt = (d: string | null): string => (d ? new Date(d).toLocaleString() : '—');

/**
 * Human label for a run's progress column.
 * - succeeded → always shows complete (100%), even when the worker reported no
 *   granular progress (exit-code mode or envelope without progress).
 * - failed/cancelled → keeps the % the run reached, or a dash when it reported none.
 * - running → the reported %, or a dash while none has arrived yet.
 */
export function progressLabel(status: string, progress: number | null | undefined): string {
  if (status === 'succeeded') return '100%';
  if (progress === null || progress === undefined) return '—';
  return `${progress}%`;
}

/**
 * `<sched-runs base="/api" token="…" limit="50">` — run history table
 * (newest first) with per-run delete. Polls every `refreshMs`. Pagination
 * footer: prev/next + page-size select (10/25/50/100); changing the size
 * resets the offset.
 */
export class SchedRuns extends LitElement {
  static styles = [shared, css`
    .del { opacity: 0; }
    tr:hover .del { opacity: 1; }
    .del.armed { opacity: 1; }
  `];

  static properties = {
    /** Mount path of the sched admin api. Default: /api. */
    base: { type: String },
    /** Optional Bearer token (SCHED_ADMIN_KEY). */
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

  private runs: RunRecord[] = [];
  private error = '';
  private busy = false;
  private hasMore = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Run id whose delete button is armed ("sure?") — two-step destructive delete. */
  private armedId: string | null = null;
  private armTimer: ReturnType<typeof setTimeout> | null = null;

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
    if (this.armTimer) clearTimeout(this.armTimer);
  }

  /** Two-step delete: first click arms ("sure?"), second click confirms; auto-disarms after 3s. */
  private onDeleteClick(runId: string): void {
    if (this.busy) return;
    if (this.armedId !== runId) {
      this.arm(runId);
      return;
    }
    this.disarm();
    void this.deleteRun(runId);
  }

  private arm(runId: string): void {
    this.armedId = runId;
    if (this.armTimer) clearTimeout(this.armTimer);
    this.armTimer = setTimeout(() => this.disarm(), 3000);
    this.requestUpdate();
  }

  private disarm(): void {
    if (this.armTimer) {
      clearTimeout(this.armTimer);
      this.armTimer = null;
    }
    this.armedId = null;
    this.requestUpdate();
  }

  private async load(): Promise<void> {
    try {
      const limit = this.limit ?? 50;
      const offset = this.offset ?? 0;
      // probe one extra row so the footer can tell whether a next page exists
      const body = (await apiGet(this.base, `/runs?limit=${limit + 1}&offset=${offset}`, this.token)) as {
        runs: RunRecord[];
      };
      this.hasMore = body.runs.length > limit;
      this.runs = pageRows(body.runs, limit);
      this.error = '';
      this.disarm(); // the armed row may be gone after refresh
      this.requestUpdate();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.requestUpdate();
    }
  }

  private async deleteRun(runId: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await apiSend(this.base, `/runs/${runId}`, this.token, 'DELETE');
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
        <span class="title">Runs</span>
        <span class="muted">${this.runs.length}</span>
        <span class="spacer"></span>
        <button class="btn" @click=${() => void this.load()}>refresh</button>
      </div>
      ${this.error ? html`<div class="err">${this.error}</div>` : ''}
      <table>
        <thead><tr><th>id</th><th>task</th><th>status</th><th>progress</th><th>started</th><th>finished</th><th>error</th><th></th></tr></thead>
        <tbody>
          ${this.runs.length === 0
            ? html`<tr><td colspan="8" class="empty">no runs yet</td></tr>`
            : repeat(
                this.runs,
                (r) => r.id,
                (r) => html`
                  <tr>
                    <td class="muted">${r.id.slice(0, 8)}</td>
                    <td>${r.taskName}</td>
                    <td><sched-status status=${r.status}></sched-status></td>
                    <td class="muted">${progressLabel(r.status, r.progress)}</td>
                    <td>${fmt(r.startedAt as unknown as string)}</td>
                    <td class="muted">${fmt(r.finishedAt as unknown as string)}</td>
                    <td class="muted">${r.error}</td>
                    <td><button class="btn danger del${this.armedId === r.id ? ' armed' : ''}" @click=${() => this.onDeleteClick(r.id)}>${this.armedId === r.id ? 'sure?' : 'del'}</button></td>
                  </tr>
                `,
              )}
        </tbody>
      </table>
      ${pagerControls(
        { offset: this.offset ?? 0, limit: (this.limit ?? 50) as PageSize, hasMore: this.hasMore ?? false },
        this.runs.length,
        { onPrev: () => this.onPrev(), onNext: () => this.onNext(), onLimit: (n) => this.onLimitChange(n) },
      )}
    `;
  }
}
