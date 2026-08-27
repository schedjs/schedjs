import { css } from 'lit';

/**
 * Shared visual language — CSS custom properties (settable by hosts) plus the
 * status-badge / table primitives every sched component reuses. Hosts can
 * override the palette through their own :root / :host variables.
 */
export const shared = css`
  :host {
    --sched-bg: #0f1115;
    --sched-card: #171a21;
    --sched-line: #2a2f3a;
    --sched-text: #e6e8ee;
    --sched-muted: #9aa3b2;
    --sched-ok: #3fb950;
    --sched-bad: #f85149;
    --sched-run: #58a6ff;
    --sched-warn: #d29922;
    --sched-radius: 8px;
    --sched-font: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    display: block;
    font: 13px/1.5 var(--sched-font);
    color: var(--sched-text);
  }
  table { width: 100%; border-collapse: collapse; background: var(--sched-card); border: 1px solid var(--sched-line); border-radius: var(--sched-radius); overflow: hidden; }
  .table-scroll { overflow-x: auto; }
  th, td { text-align: left; padding: 7px 11px; border-bottom: 1px solid var(--sched-line); font-size: 12.5px; vertical-align: top; }
  th { color: var(--sched-muted); font-weight: 500; white-space: nowrap; }
  tr:last-child td { border-bottom: none; }
  .st { display: inline-block; padding: 1px 8px; border-radius: 99px; font-size: 11px; white-space: nowrap; }
  .st.succeeded { background: #12271a; color: var(--sched-ok); }
  .st.failed { background: #2c1214; color: var(--sched-bad); }
  .st.running { background: #0f2438; color: var(--sched-run); }
  .st.queued { background: #1c2130; color: #a5b4fc; }
  .st.cancelled { background: #26262b; color: var(--sched-muted); }
  .btn { background: var(--sched-card); border: 1px solid var(--sched-line); color: var(--sched-text); border-radius: 6px; padding: 3px 9px; cursor: pointer; font: inherit; font-size: 11.5px; }
  .btn:hover { border-color: var(--sched-run); }
  .btn.danger:hover { border-color: var(--sched-bad); }
  .btn.primary { background: var(--sched-run); border-color: var(--sched-run); color: #06121f; font-weight: 600; }
  .btn.mini { padding: 1px 6px; font-size: 10.5px; }
  .btn.danger { color: var(--sched-bad); }
  .row { display: flex; align-items: center; gap: 6px; }
  /* U4 (F&F r8): actions-ячейка остаётся table-cell — flex живёт на внутреннем
     враппере, иначе td схлопывается к контенту и короче соседей по строке. */
  .actions { vertical-align: middle; white-space: nowrap; }
  .panel { background: var(--sched-card); border: 1px solid var(--sched-line); border-radius: var(--sched-radius); padding: 10px 12px; margin-bottom: 10px; }
  .form { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 8px 10px; }
  .form label { display: flex; flex-direction: column; gap: 3px; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--sched-muted); }
  .form input, .form select { background: var(--sched-bg); border: 1px solid var(--sched-line); color: var(--sched-text); border-radius: 6px; padding: 4px 7px; font: inherit; font-size: 12px; }
  .st.paused-task { background: #3a0f13; color: var(--sched-bad); }
  .st.runtime { background: #1c2130; color: #a5b4fc; }
  .st.paused-schedule { background: #33270f; color: var(--sched-warn); }
  .st.active { background: #12271a; color: var(--sched-ok); }
  .empty { color: var(--sched-muted); padding: 14px; }
  .err { color: var(--sched-bad); padding: 10px; }
  .muted { color: var(--sched-muted); }
  .head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .head .title { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--sched-muted); }
  .head .spacer { flex: 1; }
  .pager { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
  .pager select { background: var(--sched-card); border: 1px solid var(--sched-line); color: var(--sched-text); border-radius: 6px; padding: 3px 6px; font: inherit; font-size: 11.5px; cursor: pointer; }
  .pager .btn:disabled { opacity: 0.45; cursor: default; }
  pre.log { background: var(--sched-bg); border: 1px solid var(--sched-line); border-radius: 6px; padding: 10px; overflow: auto; white-space: pre-wrap; word-break: break-word; margin: 0; }
`;
