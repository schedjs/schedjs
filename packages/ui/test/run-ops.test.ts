// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'lit';
import { SchedRuns, runsQuery } from '../src/sched-runs.js';
import { SchedStatus } from '../src/sched-status.js';

// Register so nested <sched-status> stamps upgrade in the happy-dom document.
customElements.define('sched-status', SchedStatus);

const mk = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  taskName: 't',
  status: 'running',
  startedAt: '2026-08-16T09:00:00Z',
  finishedAt: null,
  error: null,
  runner: 'http',
  data: null,
  result: null,
  progress: null,
  log: null,
  artifacts: null,
  workerRef: null,
  ...overrides,
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** Stateful instance without the custom-element lifecycle (ui.test.ts pattern). */
function stateful<T>(proto: object, state: Partial<T>): T {
  const obj = { ...state } as object;
  Object.setPrototypeOf(obj, proto);
  return obj as T;
}

function renderInto<T>(proto: { render(): unknown }, state: Partial<T>): HTMLElement {
  const instance = stateful(proto, state) as { render(): unknown };
  const container = document.createElement('div');
  render(instance.render() as never, container);
  return container;
}

const fetchMock = () => globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
const calls = () => fetchMock().mock.calls.map((c) => [c[0] as string, (c[1] ?? {}) as RequestInit] as const);

describe('runsQuery (R4 filters → api query string)', () => {
  it('keeps the bare limit+offset shape when no filter is set', () => {
    expect(runsQuery({ limit: 26, offset: 0 })).toBe('/runs?limit=26&offset=0');
  });

  it('appends task/since/until/runner, url-encoded', () => {
    expect(
      runsQuery({
        limit: 26,
        offset: 25,
        task: 'sync',
        since: '2026-09-01T00:00:00.000Z',
        until: '2026-09-02T00:00:00.000Z',
        runner: 'docker',
      }),
    ).toBe(
      '/runs?limit=26&offset=25&task=sync&since=2026-09-01T00%3A00%3A00.000Z&until=2026-09-02T00%3A00%3A00.000Z&runner=docker',
    );
  });

  it('omits blank values — a cleared input must not send ?task=', () => {
    expect(runsQuery({ limit: 10, offset: 0, task: '', runner: '   ' })).toBe('/runs?limit=10&offset=0');
  });
});

describe('sched-runs filters (footer)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    fetchMock().mockResolvedValue(json({ runs: [] }));
  });

  it('a filter change resets to the first page and rides the request', async () => {
    const el = stateful(SchedRuns.prototype, { base: '/api', limit: 25, offset: 50, hasMore: true }) as unknown as {
      onFilterChange(field: string, value: string): Promise<void>;
      offset: number;
    };
    await el.onFilterChange('task', 'sync');
    expect(calls()[0]![0]).toBe('/api/runs?limit=26&offset=0&task=sync');
    expect(calls()[0]![1].method).toBe('GET');
    expect(el.offset).toBe(0);
  });

  it('converts a datetime-local bound to ISO before it reaches the api', async () => {
    const el = stateful(SchedRuns.prototype, { base: '/api', limit: 25, offset: 0 }) as unknown as {
      onFilterChange(field: string, value: string): Promise<void>;
      since?: string;
    };
    await el.onFilterChange('since', '2026-09-01T10:00');
    const iso = new Date('2026-09-01T10:00').toISOString();
    expect(el.since).toBe(iso);
    expect(calls()[0]![0]).toContain(`since=${encodeURIComponent(iso)}`);
  });

  it('clearing a bound drops it from the query', async () => {
    const el = stateful(SchedRuns.prototype, { base: '/api', limit: 25, offset: 0, since: '2026-09-01T10:00:00.000Z' }) as unknown as {
      onFilterChange(field: string, value: string): Promise<void>;
      since?: string;
    };
    await el.onFilterChange('since', '');
    expect(el.since).toBeUndefined();
    expect(calls()[0]![0]).toBe('/api/runs?limit=26&offset=0');
  });

  it('a filter survives pagination — next/prev keep sending it', () => {
    const el = stateful(SchedRuns.prototype, {
      base: '/api',
      limit: 25,
      offset: 0,
      hasMore: true,
      task: 'sync',
      runner: 'docker',
    }) as unknown as { onNext(): void; onPrev(): void };
    el.onNext();
    expect(calls()[0]![0]).toBe('/api/runs?limit=26&offset=25&task=sync&runner=docker');
    el.onPrev();
    expect(calls()[1]![0]).toBe('/api/runs?limit=26&offset=0&task=sync&runner=docker');
  });

  it('renders the filter inputs in the footer', () => {
    const out = renderInto(SchedRuns.prototype, { runs: [], limit: 25, offset: 0 });
    expect(out.querySelector('.filters')).not.toBeNull();
    expect(out.querySelector('.filters .f-task')).not.toBeNull();
    expect(out.querySelector('.filters .f-since')).not.toBeNull();
    expect(out.querySelector('.filters .f-until')).not.toBeNull();
    expect(out.querySelector('.filters .f-runner')).not.toBeNull();
  });
});

describe('sched-runs selection + bulk ops (R3)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    fetchMock().mockResolvedValue(json({ runs: [] }));
  });

  it('toggleSelect tracks the selection; unchecking removes the id', () => {
    const el = stateful(SchedRuns.prototype, { runs: [mk('r1'), mk('r2')], selected: [] }) as unknown as {
      toggleSelect(id: string, on: boolean): void;
      selected: string[];
    };
    el.toggleSelect('r1', true);
    el.toggleSelect('r2', true);
    expect(el.selected).toEqual(['r1', 'r2']);
    el.toggleSelect('r1', false);
    expect(el.selected).toEqual(['r2']);
  });

  it('select-all picks every visible row; unchecking clears the selection', () => {
    const el = stateful(SchedRuns.prototype, {
      runs: [mk('r1'), mk('r2'), mk('r3')],
      selected: ['gone'],
    }) as unknown as { toggleAll(on: boolean): void; selected: string[] };
    el.toggleAll(true);
    // display order, plus a selection that lives on another page is kept
    expect(el.selected).toEqual(['gone', 'r1', 'r2', 'r3']);
    el.toggleAll(false);
    expect(el.selected).toEqual([]);
  });

  it('bulk cancel POSTs exactly the selected ids (no more, no less)', async () => {
    fetchMock().mockResolvedValueOnce(json({ ok: ['r2', 'r3'], failed: [] }));
    const el = stateful(SchedRuns.prototype, {
      base: '/api',
      token: 'k',
      runs: [mk('r1'), mk('r2'), mk('r3')],
      selected: ['r2', 'r3'],
    }) as unknown as { bulk(action: string): Promise<void> };
    await el.bulk('cancel');
    const [url, init] = calls()[0]!;
    expect(url).toBe('/api/runs/bulk/cancel');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ ids: ['r2', 'r3'] }));
  });

  it('bulk retry hits /runs/bulk/retry', async () => {
    fetchMock().mockResolvedValueOnce(json({ ok: ['r1'], failed: [] }));
    const el = stateful(SchedRuns.prototype, {
      base: '/api',
      runs: [mk('r1')],
      selected: ['r1'],
    }) as unknown as { bulk(action: string): Promise<void> };
    await el.bulk('retry');
    expect(calls()[0]![0]).toBe('/api/runs/bulk/retry');
    expect(calls()[0]![1].method).toBe('POST');
  });

  it('keeps the partial result per id — success count and each failure with its reason', async () => {
    fetchMock().mockResolvedValueOnce(
      json({ ok: ['r2'], failed: [{ id: 'r3', reason: 'already-terminal' }] }),
    );
    const el = stateful(SchedRuns.prototype, {
      base: '/api',
      runs: [mk('r2'), mk('r3')],
      selected: ['r2', 'r3'],
    }) as unknown as {
      bulk(action: string): Promise<void>;
      bulkResult: unknown;
      selected: string[];
    };
    await el.bulk('cancel');
    expect(el.bulkResult).toEqual({
      action: 'cancel',
      ok: ['r2'],
      failed: [{ id: 'r3', reason: 'already-terminal' }],
    });
    // the batch is NOT one checkmark: the failures stay selected so the
    // operator can act on exactly the ids that did not go through
    expect(el.selected).toEqual(['r3']);

    const out = renderInto<{ bulkResult: unknown; runs: ReturnType<typeof mk>[]; selected: string[] }>(SchedRuns.prototype, {
      runs: [mk('r2'), mk('r3')],
      selected: ['r3'],
      bulkResult: el.bulkResult,
    });
    const text = out.textContent ?? '';
    expect(text).toContain('cancel');
    expect(text).toContain('1 ok');
    expect(text).toContain('1 failed');
    expect(text).toContain('r3');
    expect(text).toContain('already-terminal');
  });

  it('an id the api reports neither ok nor failed is not silently dropped', async () => {
    // partial by design = the client must reconcile, not trust the batch shape:
    // an unreported id is exactly the work that has to stay visible
    fetchMock().mockResolvedValueOnce(json({ ok: ['r1'], failed: [] })); // r2: nowhere
    const el = stateful(SchedRuns.prototype, {
      base: '/api',
      runs: [mk('r1'), mk('r2')],
      selected: ['r1', 'r2'],
    }) as unknown as { bulk(action: string): Promise<void>; bulkResult: unknown; selected: string[] };
    await el.bulk('cancel');
    expect(el.bulkResult).toEqual({
      action: 'cancel',
      ok: ['r1'],
      failed: [{ id: 'r2', reason: 'no-answer' }],
    });
    expect(el.selected).toEqual(['r2']);
  });

  it('renders a checkbox per visible row and disables the bulk buttons with no selection', () => {
    const out = renderInto(SchedRuns.prototype, { runs: [mk('r1'), mk('r2')], selected: [] });
    expect(out.querySelectorAll('input.pick')).toHaveLength(2);
    expect((out.querySelector('.bulk-cancel') as HTMLButtonElement).disabled).toBe(true);
    expect((out.querySelector('.bulk-retry') as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables the bulk buttons once a row is selected and shows the count', () => {
    const out = renderInto(SchedRuns.prototype, { runs: [mk('r1'), mk('r2')], selected: ['r1'] });
    expect((out.querySelector('.bulk-cancel') as HTMLButtonElement).disabled).toBe(false);
    expect((out.querySelector('.bulk-retry') as HTMLButtonElement).disabled).toBe(false);
    expect(out.querySelector('.sel-count')!.textContent).toContain('1');
  });

  it('surfaces an api error on a bulk call and keeps the selection', async () => {
    fetchMock().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'too many ids: 101 (max 100)' }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const el = stateful(SchedRuns.prototype, {
      base: '/api',
      runs: [mk('r1')],
      selected: ['r1'],
    }) as unknown as { bulk(action: string): Promise<void>; error: string; selected: string[] };
    await el.bulk('cancel');
    expect(el.error).toContain('too many ids');
    expect(el.selected).toEqual(['r1']);
  });
});
