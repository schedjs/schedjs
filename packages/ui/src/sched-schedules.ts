import { LitElement, html } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import type { ScheduleRecord, TaskRecord } from '@schedjs/core';
import { apiDelete, apiGet, apiPatch, apiPost } from './api.js';
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

/** Compact JSON for the data column — a long tenant payload must not blow the row. */
const dataOf = (d: unknown): string => {
  if (d === null || d === undefined) return '—';
  const s = JSON.stringify(d);
  return s.length > 40 ? s.slice(0, 37) + '…' : s;
};

/**
 * Effective pause state (decision 2026-08-18, AND semantics) — the UI must show
 * WHICH level holds the schedule, or «снял паузу, а оно молчит» happens.
 */
type EffectiveStatus = 'paused-task' | 'paused-schedule' | 'active';

const effectiveBadge = (s: EffectiveStatus): ReturnType<typeof html> => {
  if (s === 'paused-task') return html`<span class="st paused-task" title="task paused — the family stop holds">🔴 paused (task)</span>`;
  if (s === 'paused-schedule') return html`<span class="st paused-schedule" title="schedule paused — one instance">🟡 paused (schedule)</span>`;
  return html`<span class="st active" title="running">▶ active</span>`;
};

/** GET /schedules items — ScheduleRecord + the server-resolved extras (slice 4). */
interface ScheduleRow extends ScheduleRecord {
  lastRunStatus: string | null;
  effectiveStatus: EffectiveStatus;
}

/** One schedule form field group — mirrors the tasks.json ScheduleEntry shape. */
interface ScheduleFormState {
  taskName: string;
  kind: 'cron' | 'interval' | 'once';
  value: string;
  tz: string;
  data: string;
  externalId: string;
  dedupKey: string;
  retry: string;
  priority: string;
  error: string;
}

const emptyForm = (): ScheduleFormState => ({
  taskName: '',
  kind: 'cron',
  value: '',
  tz: '',
  data: '',
  externalId: '',
  dedupKey: '',
  retry: '',
  priority: '',
  error: '',
});

/** Parse a JSON string field; returns undefined when blank, throws on invalid JSON. */
function parseField(s: string): unknown {
  const t = s.trim();
  return t === '' ? undefined : (JSON.parse(t) as unknown);
}

/**
 * `<sched-schedules base="/api" token="…">` — schedules as first-class rows
 * (schedule-as-entity): taskName, rule, tz, data, effective pause status and
 * create/edit/pause/resume/delete actions. Polls every `refreshMs`.
 * The form posts `POST /schedules` (201/200 by dedupKey) and edits via
 * `PATCH /schedules/:id`; pause/resume toggle only the schedule level —
 * the effective-status column keeps the task level visible.
 */
export class SchedSchedules extends LitElement {
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

  private schedules: ScheduleRow[] = [];
  private tasks: Array<{ name: string }> = [];
  private error = '';
  private hasMore = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** null = list view; an object = the create/edit form is open. */
  private form: ScheduleFormState | null = null;
  /** id of the schedule being edited; null → create mode. */
  private editingId: string | null = null;

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
      const body = (await apiGet(this.base, `/schedules?limit=${limit + 1}&offset=${offset}`, this.token)) as {
        schedules: ScheduleRow[];
      };
      this.hasMore = body.schedules.length > limit;
      this.schedules = pageRows(body.schedules, limit);
      this.error = '';
      this.requestUpdate();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.requestUpdate();
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

  private openCreate(): void {
    void this.loadTasks();
    this.editingId = null;
    this.form = { ...emptyForm() };
    this.requestUpdate();
  }

  private openEdit(s: ScheduleRow): void {
    void this.loadTasks();
    this.editingId = s.id;
    const kind = s.schedule.kind;
    this.form = {
      taskName: s.taskName,
      kind,
      value:
        kind === 'cron'
          ? s.schedule.cron
          : kind === 'interval'
            ? `every ${s.schedule.ms / 1000} seconds`
            : // U3 (F&F r8 retest): once-строки приходят из API с `at` как ISO-строка
              // (JSON), не Date — toISOString() на строке падал. String() даёт
              // ту же ISO-строку и для строки, и для Date.
              String(s.schedule.at),
      tz: s.tz,
      data: s.data === null ? '' : JSON.stringify(s.data),
      externalId: s.externalId ?? '',
      dedupKey: s.dedupKey ?? '',
      retry: s.retry === null ? '' : JSON.stringify(s.retry),
      priority: String(s.priority),
      error: '',
    };
    this.requestUpdate();
  }

  private cancelForm(): void {
    this.form = null;
    this.editingId = null;
    this.requestUpdate();
  }

  private setForm(patch: Partial<ScheduleFormState>): void {
    if (!this.form) return;
    this.form = { ...this.form, ...patch };
    this.requestUpdate();
  }

  private async loadTasks(): Promise<void> {
    try {
      const body = (await apiGet(this.base, '/tasks?limit=1000', this.token)) as { tasks: TaskRecord[] };
      this.tasks = body.tasks.map((t) => ({ name: t.name }));
      this.requestUpdate();
    } catch {
      this.tasks = [];
    }
  }

  private async saveForm(): Promise<void> {
    if (!this.form) return;
    const f = this.form;
    if (!f.taskName) {
      this.setForm({ error: 'taskName is required' });
      return;
    }
    if (!f.value.trim()) {
      this.setForm({ error: 'schedule value is required (cron / interval / date)' });
      return;
    }
    let data: unknown;
    let retry: unknown;
    try {
      data = parseField(f.data);
      retry = parseField(f.retry);
    } catch (err) {
      this.setForm({ error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    const entry: Record<string, unknown> = { [f.kind]: f.value.trim() };
    // U1 (F&F r8 #5): tz — BODY-поле, валидно для любого kind; inner `timezone`
    // существует только у cron-entries. interval/once + inner timezone → 400
    // «timezone is only valid on cron schedules». Cron оставляет inner (F1 hoist),
    // interval/once шлют body-level tz.
    if (f.kind === 'cron' && f.tz.trim()) entry.timezone = f.tz.trim();
    if (data !== undefined) entry.data = data;
    if (f.externalId.trim()) entry.externalId = f.externalId.trim();
    if (f.dedupKey.trim()) entry.dedupKey = f.dedupKey.trim();
    if (retry !== undefined) entry.retry = retry;
    if (f.priority.trim()) {
      const p = Number(f.priority);
      if (!Number.isInteger(p) || p < 0) {
        this.setForm({ error: 'priority must be a non-negative integer' });
        return;
      }
      entry.priority = p;
    }
    const body: Record<string, unknown> = { taskName: f.taskName, schedule: entry };
    if (f.kind !== 'cron' && f.tz.trim()) body.tz = f.tz.trim();
    try {
      if (this.editingId === null) {
        await apiPost(this.base, '/schedules', this.token, body);
      } else {
        await apiPatch(this.base, `/schedules/${this.editingId}`, this.token, body);
      }
      this.form = null;
      this.editingId = null;
      void this.load();
    } catch (err) {
      this.setForm({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async togglePause(s: ScheduleRow): Promise<void> {
    try {
      await apiPost(this.base, s.paused ? `/schedules/${s.id}/resume` : `/schedules/${s.id}/pause`, this.token, {});
      void this.load();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.requestUpdate();
    }
  }

  private async deleteRow(s: ScheduleRow): Promise<void> {
    if (!window.confirm(`Delete schedule ${s.id} (task ${s.taskName})? Its runs are kept.`)) return;
    try {
      await apiDelete(this.base, `/schedules/${s.id}`, this.token);
      void this.load();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.requestUpdate();
    }
  }

  private renderForm() {
    if (!this.form) return '';
    const f = this.form;
    return html`
      <div class="panel">
        <div class="head">
          <span class="title">${this.editingId === null ? 'New schedule' : `Edit schedule ${this.editingId}`}</span>
          <span class="spacer"></span>
          <button class="btn" @click=${() => this.cancelForm()}>cancel</button>
        </div>
        <div class="form">
          <label>task
            <select @change=${(e: Event) => this.setForm({ taskName: (e.target as HTMLSelectElement).value })}>
              <option value="">— choose —</option>
              ${this.tasks.map((t) => html`<option value=${t.name} ?selected=${f.taskName === t.name}>${t.name}</option>`)}
            </select>
          </label>
          <label>kind
            <select @change=${(e: Event) => this.setForm({ kind: (e.target as HTMLSelectElement).value as ScheduleFormState['kind'] })}>
              <option value="cron" ?selected=${f.kind === 'cron'}>cron</option>
              <option value="interval" ?selected=${f.kind === 'interval'}>interval</option>
              <option value="once" ?selected=${f.kind === 'once'}>once</option>
            </select>
          </label>
          <label>value
            <input .value=${f.value} @input=${(e: Event) => this.setForm({ value: (e.target as HTMLInputElement).value })}
              placeholder=${f.kind === 'cron' ? '0 9 * * *' : f.kind === 'interval' ? 'every 5 minutes' : 'tomorrow at noon'} />
          </label>
          <label>tz
            <input .value=${f.tz} @input=${(e: Event) => this.setForm({ tz: (e.target as HTMLInputElement).value })} placeholder="UTC" />
          </label>
          <label>data (JSON)
            <input .value=${f.data} @input=${(e: Event) => this.setForm({ data: (e.target as HTMLInputElement).value })} placeholder='{"idSeller": 2}' />
          </label>
          <label>externalId
            <input .value=${f.externalId} @input=${(e: Event) => this.setForm({ externalId: (e.target as HTMLInputElement).value })} placeholder="tenant-7" />
          </label>
          <label>dedupKey
            <input .value=${f.dedupKey} @input=${(e: Event) => this.setForm({ dedupKey: (e.target as HTMLInputElement).value })} placeholder="seller-2 (upsert handle)" />
          </label>
          <label>retry (JSON)
            <input .value=${f.retry} @input=${(e: Event) => this.setForm({ retry: (e.target as HTMLInputElement).value })} placeholder='{"maxAttempts":3,"backoffMs":60000}' />
          </label>
          <label>priority
            <input .value=${f.priority} @input=${(e: Event) => this.setForm({ priority: (e.target as HTMLInputElement).value })} placeholder="0" />
          </label>
          <div class="row">
            <button class="btn primary" @click=${() => void this.saveForm()}>${this.editingId === null ? 'create' : 'save'}</button>
            ${f.error ? html`<span class="err">${f.error}</span>` : ''}
          </div>
        </div>
      </div>
    `;
  }

  render() {
    return html`
      <div class="head">
        <span class="title">Schedules</span>
        <span class="spacer"></span>
        <button class="btn" @click=${() => void this.load()}>refresh</button>
        <button class="btn primary" @click=${() => this.openCreate()}>+ new</button>
      </div>
      ${this.error ? html`<div class="err">${this.error}</div>` : ''}
      ${this.renderForm()}
      <div class="table-scroll">
      <table>
        <thead><tr><th>task</th><th>rule</th><th>tz</th><th>data</th><th>next run</th><th>last</th><th>status</th><th>actions</th></tr></thead>
        <tbody>
          ${this.schedules.length === 0
            ? html`<tr><td colspan="8" class="empty">no schedules</td></tr>`
            : repeat(
                this.schedules,
                (s) => s.id,
                (s) => html`
                  <tr>
                    <td>${s.taskName}${s.fileManaged === false ? html` <span class="st runtime" title="runtime task — not in tasks.json">runtime</span>` : ''}</td>
                    <td class="muted">${JSON.stringify(s.schedule)}</td>
                    <td class="muted">${s.tz}</td>
                    <td class="muted">${dataOf(s.data)}</td>
                    <td>${fmt(s.nextRunAt as unknown as string | null)}</td>
                    <td class="muted">${fmt(s.lastRunAt as unknown as string | null)} ${statusOf(s.lastRunStatus)}</td>
                    <td>${effectiveBadge(s.effectiveStatus)}</td>
                    <td class="actions">
                      <div class="row">
                        <button class="btn mini" @click=${() => void this.togglePause(s)}>${s.paused ? 'resume' : 'pause'}</button>
                        <button class="btn mini" @click=${() => this.openEdit(s)}>edit</button>
                        <button class="btn mini danger" @click=${() => void this.deleteRow(s)}>delete</button>
                      </div>
                    </td>
                  </tr>
                `,
              )}
        </tbody>
      </table>
      </div>
      ${pagerControls(
        { offset: this.offset ?? 0, limit: (this.limit ?? 50) as PageSize, hasMore: this.hasMore ?? false },
        this.schedules.length,
        { onPrev: () => this.onPrev(), onNext: () => this.onNext(), onLimit: (n) => this.onLimitChange(n) },
      )}
    `;
  }
}
