import { html } from 'lit';

/** Page sizes offered by the pagination footer. */
export const PAGE_SIZES = [10, 25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

/**
 * Pagination state shared by the list components (`sched-runs`, `sched-tasks`,
 * `sched-schedules`). `hasMore` is probed by fetching `limit + 1` rows and
 * trimming the probe row — the API returns no total count.
 */
export interface PagerState {
  offset: number;
  limit: PageSize;
  hasMore: boolean;
}

/** Trim the probe row: the fetched page is `limit + 1` rows to detect hasMore. */
export function pageRows<T>(rows: T[], limit: number): T[] {
  return rows.slice(0, limit);
}

/**
 * Pagination footer rendered below every list: prev / page-size select /
 * range / next. `count` = rows actually displayed (probe already trimmed).
 * Changing the page size resets the offset (handled by the caller).
 */
export function pagerControls(
  state: PagerState,
  count: number,
  handlers: { onPrev(): void; onNext(): void; onLimit(n: PageSize): void },
): unknown {
  const start = count > 0 ? state.offset + 1 : 0;
  const end = state.offset + count;
  return html`
    <div class="pager">
      <button class="btn" ?disabled=${state.offset === 0} @click=${handlers.onPrev}>‹ prev</button>
      <select
        class="btn"
        aria-label="page size"
        @change=${(e: Event) => handlers.onLimit(Number((e.target as HTMLSelectElement).value) as PageSize)}
      >
        ${PAGE_SIZES.map((n) => html`<option value=${n} ?selected=${n === state.limit}>${n}</option>`)}
      </select>
      <span class="muted">${count > 0 ? `${start}–${end}` : '0'}</span>
      <button class="btn" ?disabled=${!state.hasMore} @click=${handlers.onNext}>next ›</button>
    </div>
  `;
}
