// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SchedSchedules } from '../src/sched-schedules.js';
import { SchedTasks } from '../src/sched-tasks.js';

customElements.define('sched-tasks', SchedTasks);
customElements.define('sched-schedules', SchedSchedules);

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** Register a component and connect it into the document with fetch stubbed. */
function mount(tag: string, body: unknown, refreshMs: number): HTMLElement {
  const el = document.createElement(tag);
  (el as unknown as { refreshMs: number }).refreshMs = refreshMs; // morda sets the property directly
  document.body.appendChild(el);
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(okJson(body));
  return el;
}

describe('auto-refresh (morda sets el.refreshMs on every component)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sched-tasks re-fetches /tasks on the refreshMs interval', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn());
    const el = mount('sched-tasks', { tasks: [] }, 5000);
    await vi.advanceTimersByTimeAsync(0);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // initial load
    await vi.advanceTimersByTimeAsync(5000);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2); // poll tick
    el.remove();
  });

  it('sched-schedules re-fetches /schedules on the refreshMs interval', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn());
    const el = mount('sched-schedules', { schedules: [] }, 5000);
    await vi.advanceTimersByTimeAsync(0);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    el.remove();
  });

  it('sched-tasks polls the tasks endpoint (not runs)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn());
    const el = mount('sched-tasks', { tasks: [] }, 5000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/tasks?limit=51&offset=0',
      expect.objectContaining({ method: 'GET' }),
    );
    el.remove();
  });
});
