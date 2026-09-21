// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SchedTasks } from '../src/sched-tasks.js';

customElements.define('sched-tasks', SchedTasks);

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** GET /tasks row — TaskRecord + the server-resolved lastRunStatus. */
const task = (name: string, failCount = 0, overrides: Record<string, unknown> = {}) => ({
  name,
  runner: 'http',
  schedule: { kind: 'interval', ms: 60_000 },
  tz: 'UTC',
  config: {},
  label: null,
  description: null,
  nextRunAt: null,
  lastRunAt: null,
  lockedAt: null,
  failCount,
  retry: null,
  retryCount: 0,
  lastRunId: null,
  paused: false,
  disabled: false,
  lastRunStatus: null,
  ...overrides,
});

/** GET /schedules row — the id orders the sweep, taskName/failCount feed the FAILS cell. */
const schedule = (taskName: string, failCount: number, id = `${taskName}:${failCount}`) => ({
  id,
  taskName,
  failCount,
});

interface StubOptions {
  /** Simulate a daemon that ignores `offset`: every page returns the whole list. */
  ignoreOffset?: boolean;
}

/** Route the tasks table's endpoints; `/schedules` pages by limit/offset like the daemon. */
function stubApi(tasks: unknown[], schedules: unknown[], opts: StubOptions = {}): { paths: string[] } {
  const paths: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = new URL(url, 'http://ui.test');
      paths.push(`${u.pathname}${u.search}`);
      if (u.pathname === '/api/tasks') return okJson({ tasks });
      if (u.pathname === '/api/schedules') {
        const limit = Number(u.searchParams.get('limit') ?? '0');
        const offset = Number(u.searchParams.get('offset') ?? '0');
        return okJson({ schedules: opts.ignoreOffset ? schedules : schedules.slice(offset, offset + limit) });
      }
      return new Response('not found', { status: 404 });
    }),
  );
  return { paths };
}

/** Mount the real element (connectedCallback → load) with polling off. */
function mount(): SchedTasks {
  const el = document.createElement('sched-tasks') as SchedTasks;
  (el as unknown as { refreshMs: number }).refreshMs = 0;
  document.body.appendChild(el);
  return el;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The table's text, whitespace-normalised. happy-dom drops `<tr>`/`<td>` from lit
 * templates (see runs-list.test.ts), so cells are asserted as an ordered stream:
 * `name runner schedule next-run FAILS last-status state actions`. The FAILS cell
 * sits between `next run` and `last status` — fixtures make those two differ from
 * a dash wherever it matters, so the dash asserted below can only be FAILS.
 */
const tableText = (el: SchedTasks): string =>
  (el.shadowRoot!.querySelector('table')?.textContent ?? '').replace(/\s+/g, ' ');

const errText = (el: SchedTasks): string => el.shadowRoot!.querySelector('.err')?.textContent ?? '';

describe('sched-tasks FAILS column (R1 follow-up: schedule-driven failures live on the schedule row)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('sums the task row and its schedule rows, and prints a clean task as an em dash', async () => {
    stubApi(
      [
        task('cron-task', 0),
        task('manual', 2),
        // next run and last status are NOT dashes here: the remaining dash in
        // this row can only be the FAILS cell.
        task('clean', 0, { nextRunAt: '2026-09-20T10:00:00Z', lastRunStatus: 'succeeded' }),
      ],
      [schedule('cron-task', 2), schedule('cron-task', 1, 'cron-task:1b'), schedule('clean', 0)],
    );
    const el = mount();
    await flush();

    const text = tableText(el);
    expect(text).toContain('— 3 —'); // cron-task: 0 on the task row + 2 + 1 on its schedules
    expect(text).toContain('— 2 —'); // the manual trigger/retry path still counts
    expect(text).toContain('— ✔ succeeded'); // clean: zero prints as an em dash, as in the CLI
  });

  it('sweeps /schedules past one page — a long board is not silently undercounted', async () => {
    const many = Array.from({ length: 1001 }, (_, i) => schedule('busy', 1, `s${i}`));
    const { paths } = stubApi([task('busy', 0)], many);
    const el = mount();
    await flush();

    expect(tableText(el)).toContain('— 1001 —');
    expect(paths.some((p) => p.startsWith('/api/schedules') && p.includes('offset=0'))).toBe(true);
    expect(paths.some((p) => p.startsWith('/api/schedules') && p.includes('offset=1000'))).toBe(true);
  });

  it('pays for the extra empty page on an exact multiple of the page size (no truncation)', async () => {
    const many = Array.from({ length: 1000 }, (_, i) => schedule('busy', 1, `s${i}`));
    const { paths } = stubApi([task('busy', 0)], many);
    const el = mount();
    await flush();

    expect(tableText(el)).toContain('— 1000 —');
    // 1000 rows is a full page — the loop must ask once more instead of trusting it
    expect(paths.some((p) => p.startsWith('/api/schedules') && p.includes('offset=1000'))).toBe(true);
  });

  it('fails fast when the daemon ignores offset instead of resweeping one page forever', async () => {
    const many = Array.from({ length: 1000 }, (_, i) => schedule('busy', 1, `s${i}`));
    const { paths } = stubApi([task('busy', 0)], many, { ignoreOffset: true });
    const el = mount();
    await flush();

    expect(errText(el)).toContain('ignored offset');
    // page 0 + the repeated page 1 is enough to conclude — not 1000 round trips
    expect(paths.filter((p) => p.startsWith('/api/schedules'))).toHaveLength(2);
  });

  it('does not sweep /schedules for an empty task board', async () => {
    const { paths } = stubApi([], [schedule('t', 1)]);
    mount();
    await flush();

    expect(paths.filter((p) => p.startsWith('/api/schedules'))).toEqual([]);
  });

  it('surfaces a broken sweep as an error instead of printing a wrong number', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/api/schedules') ? okJson({ nonsense: true }) : okJson({ tasks: [task('t', 0)] }),
      ),
    );
    const el = mount();
    await flush();

    expect(tableText(el)).toContain('no tasks'); // the half-read snapshot is not committed
    expect(errText(el)).toContain('schedules');
  });

  it('recovers — a later good sweep clears the error and prints the real total', async () => {
    let broken = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = new URL(url, 'http://ui.test');
        if (u.pathname === '/api/tasks') return okJson({ tasks: [task('cron-task', 0)] });
        if (u.pathname === '/api/schedules') {
          return broken ? new Response('boom', { status: 500 }) : okJson({ schedules: [schedule('cron-task', 4)] });
        }
        return new Response('not found', { status: 404 });
      }),
    );
    const el = mount();
    await flush();
    expect(errText(el)).not.toBe('');

    broken = false;
    (el.shadowRoot!.querySelector('button') as HTMLButtonElement).click(); // the head's refresh
    await flush();

    expect(errText(el)).toBe('');
    expect(tableText(el)).toContain('— 4 —');
  });
});
