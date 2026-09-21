import { LitElement, css, html } from 'lit';
import { apiGet, apiSend } from './api.js';
import { shared } from './styles.js';

/** `GET /queue` payload (R2 — the engine owns the state, the api only reports it). */
export interface QueueInfo {
  paused: boolean;
  pausedAt: string | null;
  startPaused: boolean;
}

const fmt = (d: string | null): string => (d ? new Date(d).toLocaleString() : '');

/**
 * `<sched-queue base="/api" token="…">` — the dashboard header's queue indicator:
 * `queue: active` / `queue: paused (since …)` plus the pause/resume button, over
 * `GET /queue` and `POST /queue/pause|resume`. Lives in the header of the morda
 * shell (and is available to component consumers, so an embedded panel shows the
 * same truth).
 *
 * The api may answer **501** when the host has no queue accessor (embedded apps
 * without the engine link). We then say `queue: n/a` and disable the button —
 * never a fake "active" and never a button that cannot work.
 */
export class SchedQueue extends LitElement {
  static styles = [shared, css`
    :host { display: inline-flex; }
    .q-box { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--sched-muted); }
    .q { padding: 1px 8px; border-radius: 99px; font-size: 11px; }
    .q.active { background: #12271a; color: var(--sched-ok); }
    .q.paused { background: #33270f; color: var(--sched-warn); }
    .q.na { background: #1c2130; color: var(--sched-muted); }
    .toggle:disabled { opacity: 0.45; cursor: default; }
  `];

  static properties = {
    /** Mount path of the sched admin api. Default: /api. */
    base: { type: String },
    /** Optional Bearer token (SCHED_ADMIN_KEY). */
    token: { type: String },
    /** Auto-refresh interval in ms. 0 → no polling. Default: 5000. */
    refreshMs: { type: Number, attribute: 'refresh-ms' },
  };

  declare base: string;
  declare token?: string;
  declare refreshMs: number;

  constructor() {
    super();
    this.base = '/api';
    this.refreshMs = 5000;
  }

  private info: QueueInfo | null = null;
  private error = '';
  private busy = false;
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
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async load(): Promise<void> {
    try {
      this.info = (await apiGet(this.base, '/queue', this.token)) as QueueInfo;
      this.error = '';
    } catch (err) {
      // 501 (no queue accessor) / 401 (bad token) / network — the indicator must
      // not keep showing a stale state as if it were live
      this.info = null;
      this.error = err instanceof Error ? err.message : String(err);
    }
    this.requestUpdate();
  }

  /** Bring the queue to the opposite state; the api is idempotent, so no arming here. */
  private async toggle(): Promise<void> {
    if (this.busy || !this.info) return;
    this.busy = true;
    try {
      await apiSend(this.base, `/queue/${this.info.paused ? 'resume' : 'pause'}`, this.token, 'POST', {});
      await this.load(); // read back the effective state (pausedAt is the engine's)
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.requestUpdate();
    } finally {
      this.busy = false;
    }
  }

  render() {
    const info = this.info;
    const paused = info?.paused === true;
    const label = info ? (paused ? `queue: paused${info.pausedAt ? ` (since ${fmt(info.pausedAt)})` : ''}` : 'queue: active') : 'queue: n/a';
    const cls = info ? (paused ? 'paused' : 'active') : 'na';
    return html`
      <div class="q-box" title=${this.error || (info?.startPaused ? 'paused since process start (startPaused)' : '')}>
        <span class="q ${cls}">${label}</span>
        <button
          class="btn toggle"
          ?disabled=${!info || this.busy}
          title=${this.error}
          @click=${() => void this.toggle()}
        >${paused ? 'resume' : 'pause'}</button>
      </div>
    `;
  }
}
