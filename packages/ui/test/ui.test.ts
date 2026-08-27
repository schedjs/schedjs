// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'lit';
import { SchedStatus } from '../src/sched-status.js';
import { SchedRuns } from '../src/sched-runs.js';
import { SchedTasks } from '../src/sched-tasks.js';

// register so nested <sched-status> stamps upgrade in the happy-dom document
customElements.define('sched-status', SchedStatus);

/**
 * happy-dom forbids `new HTMLElement()` (Illegal constructor) which LitElement
 * hits in its constructor — so components are instantiated via
 * Object.create(proto) with explicit state, then render() output is stamped
 * into a plain container. This exercises template + state + api helper without
 * the custom-element lifecycle.
 */
function stateful<T>(proto: object, state: Partial<T>): T {
  // assign fields BEFORE wiring the Lit prototype — Object.assign after would
  // hit reactive setters that need constructor statics we don't have
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

const mkRun = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  taskName: 't',
  status: 'succeeded',
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

describe('sched-status', () => {
  it('renders a badge for an explicit status', () => {
    const out = renderInto(SchedStatus.prototype, { status: 'failed' });
    expect(out.querySelector('.st')!.textContent).toBe('failed');
    expect(out.querySelector('.st')!.classList.contains('failed')).toBe(true);
  });

  it('re-renders the badge when the status attribute changes (running → failed)', async () => {
    const el = document.createElement('sched-status') as SchedStatus;
    el.setAttribute('status', 'running');
    document.body.appendChild(el);
    await el.updateComplete;
    expect(el.shadowRoot!.textContent!.trim()).toBe('running');

    el.setAttribute('status', 'failed');
    await el.updateComplete;
    expect(el.shadowRoot!.textContent!.trim()).toBe('failed');
    expect(el.shadowRoot!.querySelector('.st')!.classList.contains('failed')).toBe(true);
    el.remove();
  });
});

describe('sched-runs', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('issues GET /runs with the configured base and limit', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ runs: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const el = stateful(SchedRuns.prototype, { base: '/admin', limit: 25 }) as unknown as { load(): Promise<void> };
    await el.load();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/admin/runs?limit=26&offset=0',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('renders run rows including status and error', () => {
    const out = renderInto(SchedRuns.prototype, {
      runs: [
        { id: 'r1', taskName: 'sync', status: 'failed', startedAt: '2026-08-16T09:00:00Z', finishedAt: null, error: 'boom', runner: 'http', data: null, result: null, progress: null, log: null, artifacts: null, workerRef: null },
      ],
    });
    expect(out.textContent).toContain('sync');
    expect(out.textContent).toContain('boom');
    expect(out.querySelector('sched-status')!.getAttribute('status')).toBe('failed');
    expect(out.querySelector('.del')).not.toBeNull();
  });

  it('sends the bearer token on fetch', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ runs: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const el = stateful(SchedRuns.prototype, { token: 'sekret' }) as unknown as { load(): Promise<void> };
    await el.load();
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer sekret' });
  });

  it('delete is two-step: first click arms (no DELETE), second click confirms', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ runs: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const el = stateful(SchedRuns.prototype, {
      base: '/api',
      runs: [
        { id: 'r1', taskName: 'sync', status: 'failed', startedAt: '2026-08-16T09:00:00Z', finishedAt: null, error: 'boom', runner: 'http', data: null, result: null, progress: null, log: null, artifacts: null, workerRef: null },
      ],
    }) as unknown as { onDeleteClick(id: string): void; armedId: string | null };

    el.onDeleteClick('r1');
    expect(el.armedId).toBe('r1');
    expect(globalThis.fetch).not.toHaveBeenCalled();

    // armed state renders the confirm label on the row's delete button
    const out = renderInto(SchedRuns.prototype, {
      runs: [
        { id: 'r1', taskName: 'sync', status: 'failed', startedAt: '2026-08-16T09:00:00Z', finishedAt: null, error: 'boom', runner: 'http', data: null, result: null, progress: null, log: null, artifacts: null, workerRef: null },
      ],
      armedId: 'r1',
    });
    expect(out.querySelector('.del')!.textContent).toBe('sure?');

    el.onDeleteClick('r1');
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/runs/r1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('disarms after the arm timeout without deleting', () => {
    vi.useFakeTimers();
    const el = stateful(SchedRuns.prototype, {
      base: '/api',
      runs: [],
    }) as unknown as { onDeleteClick(id: string): void; armedId: string | null };

    el.onDeleteClick('r1');
    expect(el.armedId).toBe('r1');
    vi.advanceTimersByTime(3001);
    expect(el.armedId).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('loads limit+1 probe rows, trims the probe and flags hasMore', async () => {
    const runs = Array.from({ length: 26 }, (_, i) => mkRun(`r${i}`));
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ runs }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const el = stateful(SchedRuns.prototype, { base: '/api', limit: 25, offset: 0 }) as unknown as {
      load(): Promise<void>;
      runs: unknown[];
      hasMore: boolean;
    };
    await el.load();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/runs?limit=26&offset=0',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(el.runs).toHaveLength(25);
    expect(el.hasMore).toBe(true);
  });

  it('footer renders prev/next and a page-size select with 10/25/50/100', () => {
    const out = renderInto(SchedRuns.prototype, { runs: [], offset: 0, limit: 25, hasMore: false });
    expect(out.querySelectorAll('.pager button')).toHaveLength(2);
    const options = [...out.querySelectorAll('.pager option')].map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['10', '25', '50', '100']);
  });

  it('footer disables prev at offset 0 and next on the last page', () => {
    const first = renderInto(SchedRuns.prototype, { runs: [], offset: 0, limit: 25, hasMore: false });
    const [prev, next] = [...first.querySelectorAll('.pager button')] as HTMLButtonElement[];
    expect(prev!.disabled).toBe(true);
    expect(next!.disabled).toBe(true);

    const last = renderInto(SchedRuns.prototype, { runs: [mkRun('a')], offset: 25, limit: 25, hasMore: false });
    const [prev2, next2] = [...last.querySelectorAll('.pager button')] as HTMLButtonElement[];
    expect(prev2!.disabled).toBe(false);
    expect(next2!.disabled).toBe(true);
  });

  it('footer next advances offset by page size and reloads; prev goes back', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ runs: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const el = stateful(SchedRuns.prototype, { base: '/api', limit: 25, offset: 0, hasMore: true }) as unknown as {
      onNext(): void;
      onPrev(): void;
      offset: number;
    };
    el.onNext();
    expect(el.offset).toBe(25);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/runs?limit=26&offset=25',
      expect.objectContaining({ method: 'GET' }),
    );
    el.onPrev();
    expect(el.offset).toBe(0);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/runs?limit=26&offset=0',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('changing page size resets the offset to the first page', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ runs: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const el = stateful(SchedRuns.prototype, { base: '/api', limit: 25, offset: 75 }) as unknown as {
      onLimitChange(n: number): void;
      offset: number;
      limit: number;
    };
    el.onLimitChange(100);
    expect(el.offset).toBe(0);
    expect(el.limit).toBe(100);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/runs?limit=101&offset=0',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

describe('sched-tasks', () => {
  it('renders the task list with pause action for active tasks', () => {
    const out = renderInto(SchedTasks.prototype, {
      tasks: [
        { name: 't1', runner: 'http', schedule: { kind: 'interval', ms: 60000 }, tz: 'UTC', config: {}, label: null, description: null, nextRunAt: null, lastRunAt: null, lockedAt: null, failCount: 2, paused: false, disabled: false },
      ],
    });
    expect(out.textContent).toContain('t1');
    expect(out.textContent).toContain('pause');
    expect(out.textContent).toContain('2');
  });
});
