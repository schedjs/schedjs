import { LitElement, html } from 'lit';
import type { RunRecord } from '@schedjs/core';
import { apiGet } from './api.js';
import { shared } from './styles.js';
import './sched-status.js';


const fmt = (d: string | null): string => (d ? new Date(d).toLocaleString() : '—');

/**
 * `<sched-task-run run-id="…" base="/api">` — detail of one run: status,
 * result, log, artifacts. Refetches while the run is in flight.
 */
export class SchedTaskRun extends LitElement {
  static styles = [shared];

  static properties = {
    runId: { type: String, attribute: 'run-id' },
    base: { type: String },
    token: { type: String },
    refreshMs: { type: Number, attribute: 'refresh-ms' },
  };

  declare runId: string;
  declare base: string;
  declare token?: string;
  declare refreshMs: number;

  constructor() {
    super();
    this.runId = '';
    this.base = '/api';
    this.refreshMs = 3000;
  }

  private run: RunRecord | null = null;
  private error = '';
  private missing = false;
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
    if (!this.runId) return;
    try {
      this.run = (await apiGet(this.base, `/runs/${encodeURIComponent(this.runId)}`, this.token)) as RunRecord;
      this.missing = false;
      this.error = '';
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.missing = true;
    }
    this.requestUpdate();
  }

  render() {
    if (this.missing) return html`<div class="err">run ${this.runId} not found (${this.error})</div>`;
    if (!this.run) return html`<div class="empty">loading…</div>`;
    const r = this.run;
    return html`
      <div class="head">
        <span class="title">Run</span>
        <span class="muted">${r.id}</span>
        <span class="spacer"></span>
        <sched-status status=${r.status}></sched-status>
      </div>
      <table>
        <tbody>
          <tr><th>task</th><td>${r.taskName}</td></tr>
          <tr><th>runner</th><td>${r.runner}</td></tr>
          <tr><th>started</th><td>${fmt(r.startedAt as unknown as string)}</td></tr>
          <tr><th>finished</th><td>${fmt(r.finishedAt as unknown as string)}</td></tr>
          <tr><th>progress</th><td>${r.progress === null ? '—' : `${r.progress}%`}</td></tr>
          <tr><th>worker</th><td class="muted">${r.workerRef}</td></tr>
          ${r.error ? html`<tr><th>error</th><td class="err">${r.error}</td></tr>` : ''}
        </tbody>
      </table>
      ${r.result !== null
        ? html`<div class="head" style="margin-top:14px"><span class="title">Result</span></div><pre class="log">${JSON.stringify(r.result, null, 2)}</pre>`
        : ''}
      ${r.artifacts && r.artifacts.length
        ? html`
            <div class="head" style="margin-top:14px"><span class="title">Artifacts</span></div>
            <table><tbody>
              ${r.artifacts.map((a) => html`<tr><td>${a.label ?? a.kind}</td><td class="muted">${a.ref}</td></tr>`)}
            </tbody></table>`
        : ''}
      ${r.log !== null && r.log !== undefined && r.log !== ''
        ? html`<div class="head" style="margin-top:14px"><span class="title">Log</span></div><pre class="log">${typeof r.log === 'string' ? r.log : JSON.stringify(r.log, null, 2)}</pre>`
        : ''}
    `;
  }
}
