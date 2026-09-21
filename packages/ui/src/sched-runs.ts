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
 * The run-list query state — an R4 filter set plus pagination. All four filter
 * fields are optional and a blank value is *dropped*, never sent (`?task=` would
 * mean "task named empty string" to an unsuspecting client).
 */
export interface RunsQueryState {
  limit: number;
  offset: number;
  task?: string | undefined;
  /** ISO-8601; the api windows on `started_at`, inclusive. */
  since?: string | undefined;
  until?: string | undefined;
  runner?: string | undefined;
}

/**
 * `/runs?limit=&offset=[&task=&since=&until=&runner=]` — the single place the
 * list builds its query, so the footer filters cannot drift from the api
 * contract and pagination cannot silently drop a filter.
 */
export function runsQuery(state: RunsQueryState): string {
  const params = new URLSearchParams({ limit: String(state.limit), offset: String(state.offset) });
  for (const key of ['task', 'since', 'until', 'runner'] as const) {
    const value = state[key];
    if (value !== undefined && value.trim() !== '') params.set(key, value.trim());
  }
  return `/runs?${params.toString()}`;
}

/** Why one id of a bulk batch was not applied (the api's partial-result reasons). */
export type BulkFailureReason = 'not-found' | 'already-terminal' | 'not-cancellable' | (string & {});

/**
 * The api's answer to a bulk call, kept per id: the batch is partial by design,
 * so the UI must show which ids went through and which did not, each with its
 * reason — never one checkmark for the whole batch. `no-answer` is the
 * client-side reason for an id the api reported in neither array.
 */
export interface BulkResult {
  action: 'cancel' | 'retry';
  ok: string[];
  failed: Array<{ id: string; reason: BulkFailureReason }>;
}

/** `datetime-local` value (wall clock) → ISO; invalid/blank → undefined. */
export function toIso(value: string): string | undefined {
  if (value.trim() === '') return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** ISO → the `YYYY-MM-DDTHH:mm` a `datetime-local` input shows (in local time). */
export function toLocalInput(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * `<sched-runs base="/api" token="…" limit="50">` — run history table
 * (newest first) with per-run delete. Polls every `refreshMs`.
 *
 * Footer: filters (`task`, `since`/`until` on `started_at`, `runner`) + pagination
 * (prev/next + page-size select, changing the size resets the offset). Filter
 * values are component state, so they ride every request — including paging.
 *
 * Selection + bulk: each row has a checkbox; the head carries `cancel`/`retry`
 * over the ticked ids (`POST /runs/bulk/cancel|retry`). The api answers
 * partially, so the result block lists the ok count **and** every failed id with
 * its reason; failed ids stay ticked (that is the work that remains).
 */
export class SchedRuns extends LitElement {
  static styles = [shared, css`
    .del { opacity: 0; }
    tr:hover .del { opacity: 1; }
    .del.armed { opacity: 1; }
    .filters { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
    .filters label { display: flex; flex-direction: column; gap: 3px; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--sched-muted); }
    .filters input { background: var(--sched-bg); border: 1px solid var(--sched-line); color: var(--sched-text); border-radius: 6px; padding: 4px 7px; font: inherit; font-size: 12px; }
    .filters .f-task, .filters .f-runner { width: 140px; }
    .sel-count { font-size: 11.5px; }
    .bulk-result { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; font-size: 12px; }
    .bulk-result .ok { color: var(--sched-ok); }
    .bulk-result .bad { color: var(--sched-bad); }
    .bulk-result .failed-list { list-style: none; display: flex; gap: 10px; flex-wrap: wrap; margin: 0; padding: 0; color: var(--sched-bad); }
    input[type="checkbox"] { accent-color: var(--sched-run); }
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
    /** Filter: task name (exact match). */
    task: { type: String },
    /** Filter: start-time window lower bound, ISO-8601 (inclusive). */
    since: { type: String },
    /** Filter: start-time window upper bound, ISO-8601 (inclusive). */
    until: { type: String },
    /** Filter: exact runner match ('docker', 'http', 'process'…). */
    runner: { type: String },
  };

  declare base: string;
  declare token?: string;
  declare refreshMs: number;
  declare limit: number;
  declare offset: number;
  declare task: string;
  declare since: string | undefined;
  declare until: string | undefined;
  declare runner: string;

  constructor() {
    super();
    this.base = '/api';
    this.refreshMs = 5000;
    this.limit = 50;
    this.offset = 0;
    this.task = '';
    this.since = undefined;
    this.until = undefined;
    this.runner = '';
  }

  private runs: RunRecord[] = [];
  private error = '';
  private busy = false;
  private hasMore = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Run id whose delete button is armed ("sure?") — two-step destructive delete. */
  private armedId: string | null = null;
  private armTimer: ReturnType<typeof setTimeout> | null = null;
  /** Ids ticked for a bulk cancel/retry, in click order; survives paging/filters. */
  private selected: string[] = [];
  /** Last bulk answer — per-id truth, rendered as returned (partial by design). */
  private bulkResult: BulkResult | null = null;

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

  private get selectedIds(): string[] {
    return this.selected ?? [];
  }

  /**
   * The ids a bulk call will carry: the ticked rows in display order, then any
   * id ticked on another page (click order) so cross-page selections are not
   * silently dropped.
   */
  private bulkIds(): string[] {
    const ticked = new Set(this.selectedIds);
    const ids = this.runs.filter((r) => ticked.has(r.id)).map((r) => r.id);
    for (const id of this.selectedIds) if (!ids.includes(id)) ids.push(id);
    return ids;
  }

  private toggleSelect(id: string, on: boolean): void {
    const current = this.selectedIds;
    this.selected = on
      ? current.includes(id)
        ? current
        : [...current, id]
      : current.filter((x) => x !== id);
    this.requestUpdate();
  }

  /** Head checkbox: `false` clears everything (predictable), `true` adds the page. */
  private toggleAll(on: boolean): void {
    if (!on) {
      this.selected = [];
      this.requestUpdate();
      return;
    }
    const next = [...this.selectedIds];
    for (const r of this.runs) if (!next.includes(r.id)) next.push(r.id);
    this.selected = next;
    this.requestUpdate();
  }

  private async load(): Promise<void> {
    try {
      const limit = this.limit ?? 50;
      const offset = this.offset ?? 0;
      // probe one extra row so the footer can tell whether a next page exists
      const body = (await apiGet(
        this.base,
        runsQuery({
          limit: limit + 1,
          offset,
          task: this.task,
          since: this.since,
          until: this.until,
          runner: this.runner,
        }),
        this.token,
      )) as { runs: RunRecord[] };
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

  /**
   * Bulk cancel/retry over the ticked ids. The api is partial: on 200 we show
   * its `{ ok, failed:[{id,reason}] }` verbatim and leave the failed ids ticked
   * — that is exactly the work that did not happen.
   */
  private async bulk(action: 'cancel' | 'retry'): Promise<void> {
    if (this.busy) return;
    const ids = this.bulkIds();
    if (ids.length === 0) return;
    this.busy = true;
    try {
      const res = (await apiSend(this.base, `/runs/bulk/${action}`, this.token, 'POST', { ids })) as {
        ok?: string[];
        failed?: Array<{ id: string; reason: BulkFailureReason }>;
      };
      const ok = Array.isArray(res.ok) ? res.ok : [];
      const answered = Array.isArray(res.failed) ? res.failed : [];
      // reconcile client-side: partial means partial — an id the api answers
      // for neither in `ok` nor in `failed` must not vanish from both the
      // selection and the report (the operator would see a clean batch)
      const answeredIds = new Set([...ok, ...answered.map((f) => f.id)]);
      const failed: Array<{ id: string; reason: BulkFailureReason }> = [
        ...answered,
        ...ids.filter((id) => !answeredIds.has(id)).map((id) => ({ id, reason: 'no-answer' as const })),
      ];
      this.bulkResult = { action, ok, failed };
      this.selected = failed.map((f) => f.id);
      this.error = '';
      await this.load();
    } catch (err) {
      // the batch never went out (400/422/network) — keep the selection as-is
      this.error = err instanceof Error ? err.message : String(err);
      this.requestUpdate();
    } finally {
      this.busy = false;
    }
  }

  /**
   * A footer filter changed: store it, drop back to the first page (an offset
   * from the unfiltered list is meaningless) and reload. `since`/`until` come
   * from a `datetime-local` input as wall clock — the api takes ISO.
   */
  private async onFilterChange(
    field: 'task' | 'since' | 'until' | 'runner',
    value: string,
  ): Promise<void> {
    if (field === 'task') this.task = value.trim();
    else if (field === 'runner') this.runner = value.trim();
    else if (field === 'since') this.since = toIso(value);
    else this.until = toIso(value);
    this.offset = 0;
    this.bulkResult = null;
    await this.load();
  }

  private clearFilters(): void {
    this.task = '';
    this.runner = '';
    this.since = undefined;
    this.until = undefined;
    this.offset = 0;
    this.bulkResult = null;
    void this.load();
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
    const selected = new Set(this.selectedIds);
    const selectedCount = this.selectedIds.length;
    const allTicked = this.runs.length > 0 && this.runs.every((r) => selected.has(r.id));
    return html`
      <div class="head">
        <span class="title">Runs</span>
        <span class="muted">${this.runs.length}</span>
        <span class="spacer"></span>
        <span class="sel-count muted">${selectedCount} selected</span>
        <button
          class="btn danger bulk-cancel"
          ?disabled=${selectedCount === 0 || this.busy}
          @click=${() => void this.bulk('cancel')}
        >cancel</button>
        <button
          class="btn bulk-retry"
          ?disabled=${selectedCount === 0 || this.busy}
          @click=${() => void this.bulk('retry')}
        >retry</button>
        <button class="btn" @click=${() => void this.load()}>refresh</button>
      </div>
      ${this.error ? html`<div class="err">${this.error}</div>` : ''}
      ${this.bulkResult
        ? html`<div class="bulk-result">
            <span class="muted">${this.bulkResult.action}:</span>
            <span class="ok">${this.bulkResult.ok.length} ok</span>
            ${this.bulkResult.failed.length > 0
              ? html`<span class="bad">${this.bulkResult.failed.length} failed</span>
                  <ul class="failed-list">
                    ${this.bulkResult.failed.map((f) => html`<li>${f.id} — ${f.reason}</li>`)}
                  </ul>`
              : ''}
          </div>`
        : ''}
      <table>
        <thead><tr><th><input type="checkbox" class="pick-all" .checked=${allTicked} @change=${(e: Event) => this.toggleAll((e.target as HTMLInputElement).checked)}></th><th>id</th><th>task</th><th>status</th><th>progress</th><th>started</th><th>finished</th><th>error</th><th></th></tr></thead>
        <tbody>
          ${this.runs.length === 0
            ? html`<tr><td colspan="9" class="empty">no runs yet</td></tr>`
            : repeat(
                this.runs,
                (r) => r.id,
                (r) => html`
                  <tr>
                    <td><input type="checkbox" class="pick" .checked=${selected.has(r.id)} @change=${(e: Event) => this.toggleSelect(r.id, (e.target as HTMLInputElement).checked)}></td>
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
      <div class="filters">
        <label>task<input class="f-task" .value=${this.task ?? ''} @change=${(e: Event) => void this.onFilterChange('task', (e.target as HTMLInputElement).value)}></label>
        <label>since<input type="datetime-local" class="f-since" .value=${toLocalInput(this.since)} @change=${(e: Event) => void this.onFilterChange('since', (e.target as HTMLInputElement).value)}></label>
        <label>until<input type="datetime-local" class="f-until" .value=${toLocalInput(this.until)} @change=${(e: Event) => void this.onFilterChange('until', (e.target as HTMLInputElement).value)}></label>
        <label>runner<input class="f-runner" .value=${this.runner ?? ''} @change=${(e: Event) => void this.onFilterChange('runner', (e.target as HTMLInputElement).value)}></label>
        <button class="btn" @click=${() => this.clearFilters()}>clear</button>
      </div>
      ${pagerControls(
        { offset: this.offset ?? 0, limit: (this.limit ?? 50) as PageSize, hasMore: this.hasMore ?? false },
        this.runs.length,
        { onPrev: () => this.onPrev(), onNext: () => this.onNext(), onLimit: (n) => this.onLimitChange(n) },
      )}
    `;
  }
}
