// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'lit';
import { SchedQueue } from '../src/sched-queue.js';

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

describe('sched-queue indicator (R2 pause in the dashboard header)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('reads GET /queue and renders queue: active', async () => {
    fetchMock().mockResolvedValue(json({ paused: false, pausedAt: null, startPaused: false }));
    const el = stateful(SchedQueue.prototype, { base: '/api', refreshMs: 0 }) as unknown as {
      load(): Promise<void>;
      info: unknown;
    };
    await el.load();
    expect(calls()[0]![0]).toBe('/api/queue');
    expect(calls()[0]![1].method).toBe('GET');

    const out = renderInto<{ info: unknown }>(SchedQueue.prototype, { info: el.info });
    expect(out.textContent).toContain('queue: active');
    expect(out.querySelector('.toggle')!.textContent).toContain('pause');
  });

  it('renders queue: paused with the pause moment and offers resume', () => {
    const out = renderInto<{ info: unknown }>(SchedQueue.prototype, {
      info: { paused: true, pausedAt: '2026-09-20T09:30:00.000Z', startPaused: false },
    });
    expect(out.textContent).toContain('queue: paused');
    expect(out.querySelector('.q')!.classList.contains('paused')).toBe(true);
    expect(out.querySelector('.toggle')!.textContent).toContain('resume');
  });

  it('POSTs /queue/pause when active and switches the indicator', async () => {
    let paused = false;
    fetchMock().mockImplementation((url: string, init: RequestInit = {}) => {
      if (init.method === 'POST') {
        paused = String(url).endsWith('/pause');
        return Promise.resolve(json({ ok: true, paused, pausedAt: paused ? '2026-09-20T09:30:00.000Z' : null }));
      }
      return Promise.resolve(json({ paused, pausedAt: paused ? '2026-09-20T09:30:00.000Z' : null, startPaused: false }));
    });
    const el = stateful(SchedQueue.prototype, { base: '/api', refreshMs: 0 }) as unknown as {
      load(): Promise<void>;
      toggle(): Promise<void>;
      info: { paused: boolean };
    };
    await el.load();
    await el.toggle();
    expect(calls().some(([url, init]) => url === '/api/queue/pause' && init.method === 'POST')).toBe(true);
    expect(el.info.paused).toBe(true);
    expect(renderInto<{ info: unknown }>(SchedQueue.prototype, { info: el.info }).textContent).toContain(
      'queue: paused',
    );
  });

  it('POSTs /queue/resume while paused and switches back to active', async () => {
    let paused = true;
    fetchMock().mockImplementation((url: string, init: RequestInit = {}) => {
      if (init.method === 'POST') {
        paused = !String(url).endsWith('/resume');
        return Promise.resolve(json({ ok: true, paused, pausedAt: null }));
      }
      return Promise.resolve(json({ paused, pausedAt: null, startPaused: false }));
    });
    const el = stateful(SchedQueue.prototype, { base: '/api', refreshMs: 0 }) as unknown as {
      load(): Promise<void>;
      toggle(): Promise<void>;
      info: { paused: boolean };
    };
    await el.load();
    await el.toggle();
    expect(calls().some(([url, init]) => url === '/api/queue/resume' && init.method === 'POST')).toBe(true);
    expect(el.info.paused).toBe(false);
  });

  it('says n/a instead of faking "active" when the host has no queue accessor (501)', async () => {
    fetchMock().mockResolvedValue(
      new Response(JSON.stringify({ error: 'queue control not configured (no queue accessor)' }), {
        status: 501,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const el = stateful(SchedQueue.prototype, { base: '/api', refreshMs: 0 }) as unknown as {
      load(): Promise<void>;
      error: string;
    };
    await el.load();
    const out = renderInto<{ error: string }>(SchedQueue.prototype, { error: el.error });
    expect(out.textContent).toContain('queue: n/a');
    expect((out.querySelector('.toggle') as HTMLButtonElement).disabled).toBe(true);
    expect(out.querySelector('.toggle')!.getAttribute('title')).toContain('no queue accessor');
  });

  it('sends the bearer token', async () => {
    fetchMock().mockResolvedValue(json({ paused: false, pausedAt: null, startPaused: false }));
    const el = stateful(SchedQueue.prototype, { base: '/api', token: 'sekret', refreshMs: 0 }) as unknown as {
      load(): Promise<void>;
    };
    await el.load();
    expect(calls()[0]![1].headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer sekret',
    });
  });
});
