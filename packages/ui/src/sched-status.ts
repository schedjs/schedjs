import { LitElement, css, html } from 'lit';
import { shared } from './styles.js';

/**
 * `<sched-status status="failed">` — a run-status badge. Pure presentational;
 * the only component with zero network access (safe for any embed).
 *
 * `<sched-status effective="paused-task">` — the schedule pause badge
 * (decision 2026-08-18 AND semantics): 🔴 the task holds the pause, 🟡 only
 * this schedule does. Rendered when the `effective` attribute is set.
 */
export class SchedStatus extends LitElement {
  static styles = [shared, css`
    :host { display: inline-block; }
  `];

  static properties = {
    status: { type: String },
    effective: { type: String },
  };

  declare status: string;
  declare effective?: string | undefined;

  constructor() {
    super();
    this.status = 'queued';
    this.effective = undefined;
  }

  render() {
    if (this.effective === 'paused-task') {
      return html`<span class="st paused-task" title="task paused — the family stop holds">🔴 paused (task)</span>`;
    }
    if (this.effective === 'paused-schedule') {
      return html`<span class="st paused-schedule" title="schedule paused — one instance">🟡 paused (schedule)</span>`;
    }
    if (this.effective === 'active') {
      return html`<span class="st active" title="running">▶ active</span>`;
    }
    return html`<span class="st ${this.status}" title="run status">${this.status}</span>`;
  }
}
