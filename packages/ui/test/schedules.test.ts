// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'lit';
import { SchedSchedules } from '../src/sched-schedules.js';
import { shared } from '../src/styles.js';
import type { ScheduleRecord } from '@schedjs/core';

const mkSchedule = (overrides: Record<string, unknown> = {}): ScheduleRecord & { lastRunStatus: string | null; effectiveStatus: string } =>
  ({
    id: 's1',
    taskName: 'sync-seller',
    schedule: { kind: 'cron', cron: '0 9 * * *' },
    tz: 'UTC',
    data: { idSeller: 2 },
    externalId: 'seller-2',
    dedupKey: 'seller-2',
    nextRunAt: '2026-08-17T09:00:00Z',
    lastRunAt: null,
    lockedAt: null,
    failCount: 0,
    priority: 0,
    retry: null,
    retryCount: 0,
    lastRunId: null,
    paused: false,
    disabled: false,
    fileManaged: true,
    lastRunStatus: null,
    effectiveStatus: 'active',
    ...overrides,
  }) as unknown as ScheduleRecord & { lastRunStatus: string | null; effectiveStatus: string };

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

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('sched-schedules (schedule-as-entity)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('renders the schedule-as-entity columns: task, rule, tz, data, effective status', () => {
    const out = renderInto(SchedSchedules.prototype, {
      schedules: [mkSchedule(), mkSchedule({ id: 's2', taskName: 'sync-other', effectiveStatus: 'paused-task' })],
      hasMore: false,
      error: '',
      tasks: [],
      form: null,
      editingId: null,
    });
    const text = out.textContent ?? '';
    expect(text).toContain('sync-seller');
    expect(text).toContain('"cron":"0 9 * * *"');
    expect(text).toContain('{"idSeller":2}');
    expect(text).toContain('▶ active');
    expect(text).toContain('sync-other');
    expect(text).toContain('🔴 paused (task)');
  });

  it('shows the schedule-level pause distinctly (🟡) — the «снял паузу, а оно молчит» trap', () => {
    const out = renderInto(SchedSchedules.prototype, {
      schedules: [mkSchedule({ effectiveStatus: 'paused-schedule' })],
      hasMore: false,
      error: '',
      tasks: [],
      form: null,
      editingId: null,
    });
    expect(out.textContent).toContain('🟡 paused (schedule)');
  });

  it('renders the create form with task picker and schedule fields when open', () => {
    const out = renderInto(SchedSchedules.prototype, {
      schedules: [],
      hasMore: false,
      error: '',
      tasks: [{ name: 'sync-seller' }, { name: 'sync-other' }],
      form: {
        taskName: '',
        kind: 'cron',
        value: '',
        tz: '',
        data: '',
        externalId: '',
        dedupKey: '',
        retry: '',
        priority: '',
        error: '',
      },
      editingId: null,
    });
    const panel = out.querySelector('.panel')!;
    expect(panel.textContent).toContain('New schedule');
    const options = panel.querySelectorAll('label:first-of-type select option');
    expect(options.length).toBe(3); // — choose — + two tasks
    expect(panel.textContent).toContain('dedupKey');
  });

  it('loads /schedules with pagination and refreshes', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ schedules: [mkSchedule()] }));
    const el = stateful(SchedSchedules.prototype, {
      base: '/api',
      token: 't',
      refreshMs: 0,
      limit: 50,
      offset: 0,
      schedules: [],
      hasMore: false,
      error: '',
      tasks: [],
      form: null,
      editingId: null,
    }) as unknown as { load(): Promise<void>; schedules: unknown[] };
    await el.load();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/schedules?limit=51&offset=0',
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer t' }) }),
    );
    expect(el.schedules).toHaveLength(1);
  });

  it('creates via POST /schedules from the form (entry fields inside schedule)', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ schedules: [] })); // reload after save
    const el = stateful(SchedSchedules.prototype, {
      base: '/api',
      token: undefined,
      refreshMs: 0,
      limit: 50,
      offset: 0,
      schedules: [],
      hasMore: false,
      error: '',
      tasks: [{ name: 'sync-seller' }],
      form: {
        taskName: 'sync-seller',
        kind: 'cron',
        value: '0 9 * * *',
        tz: 'Europe/Moscow',
        data: '{"idSeller":2}',
        externalId: '',
        dedupKey: 'seller-2',
        retry: '{"maxAttempts":3,"backoffMs":60000}',
        priority: '5',
        error: '',
      },
      editingId: null,
    }) as unknown as { saveForm(): Promise<void> };
    await el.saveForm();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(url).toBe('/api/schedules');
    expect(JSON.parse(String(init.body))).toEqual({
      taskName: 'sync-seller',
      schedule: {
        cron: '0 9 * * *',
        timezone: 'Europe/Moscow',
        data: { idSeller: 2 },
        dedupKey: 'seller-2',
        retry: { maxAttempts: 3, backoffMs: 60000 },
        priority: 5,
      },
    });
  });

  it('U1: sends interval tz as BODY-level tz, not inner timezone (400 fix)', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ schedules: [] })); // reload after save
    const el = stateful(SchedSchedules.prototype, {
      base: '/api',
      token: undefined,
      refreshMs: 0,
      limit: 50,
      offset: 0,
      schedules: [],
      hasMore: false,
      error: '',
      tasks: [{ name: 'sync-seller' }],
      form: {
        taskName: 'sync-seller',
        kind: 'interval',
        value: '1h',
        tz: 'UTC',
        data: '',
        externalId: '',
        dedupKey: '',
        retry: '',
        priority: '',
        error: '',
      },
      editingId: null,
    }) as unknown as { saveForm(): Promise<void> };
    await el.saveForm();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(url).toBe('/api/schedules');
    expect(JSON.parse(String(init.body))).toEqual({
      taskName: 'sync-seller',
      schedule: { interval: '1h' },
      tz: 'UTC',
    });
  });

  it('U1: edits an API-created interval row via PATCH with body-level tz (round-trip)', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ schedules: [] })); // reload after save
    const el = stateful(SchedSchedules.prototype, {
      base: '/api',
      token: undefined,
      refreshMs: 0,
      limit: 50,
      offset: 0,
      schedules: [],
      hasMore: false,
      error: '',
      tasks: [],
      form: {
        taskName: 'sync-seller',
        kind: 'once',
        value: '2026-09-01T09:00:00Z',
        tz: 'Asia/Tokyo',
        data: '',
        externalId: '',
        dedupKey: '',
        retry: '',
        priority: '',
        error: '',
      },
      editingId: 's1',
    }) as unknown as { saveForm(): Promise<void> };
    await el.saveForm();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('PATCH');
    expect(url).toBe('/api/schedules/s1');
    expect(JSON.parse(String(init.body))).toEqual({
      taskName: 'sync-seller',
      schedule: { once: '2026-09-01T09:00:00Z' },
      tz: 'Asia/Tokyo',
    });
  });

  it('marks runtime tasks (fileManaged=false) distinctly — admin r8 note', () => {
    const out = renderInto(SchedSchedules.prototype, {
      schedules: [mkSchedule(), mkSchedule({ id: 's2', taskName: 'adhoc-job', fileManaged: false })],
      hasMore: false,
      error: '',
      tasks: [],
      form: null,
      editingId: null,
    });
    expect(out.textContent).toContain('adhoc-job');
    expect(out.textContent).toContain('runtime');
  });

  it('U2: wraps the schedules table in a scroll container (overflow fix)', () => {
    const out = renderInto(SchedSchedules.prototype, {
      schedules: [mkSchedule(), mkSchedule({ id: 's2', taskName: 'sync-other' })],
      hasMore: false,
      error: '',
      tasks: [],
      form: null,
      editingId: null,
    });
    const wrap = out.querySelector('.table-scroll');
    expect(wrap).not.toBeNull();
    expect(wrap!.querySelector('table')).not.toBeNull();
  });

  it('U3: openEdit prefills a once schedule from the JSON string (at is string from API, not Date)', () => {
    const onceRow = mkSchedule({
      id: 's-once',
      taskName: 'adhoc-once',
      schedule: { kind: 'once', at: '2026-08-19T12:00:00.000Z' },
      tz: 'Asia/Tokyo',
    });
    const el = stateful(SchedSchedules.prototype, {
      base: '/api',
      token: undefined,
      refreshMs: 0,
      limit: 50,
      offset: 0,
      schedules: [onceRow],
      hasMore: false,
      error: '',
      tasks: [],
      form: null,
      editingId: null,
    }) as unknown as {
      openEdit(s: unknown): void;
      form: { value: string; tz: string; kind: string } | null;
    };
    expect(() => el.openEdit(onceRow)).not.toThrow();
    expect(el.form?.kind).toBe('once');
    expect(el.form?.value).toBe('2026-08-19T12:00:00.000Z');
    expect(el.form?.tz).toBe('Asia/Tokyo');
  });

  it('U4: actions stay table-cell — .actions css rule added, buttons still render', () => {
    const out = renderInto(SchedSchedules.prototype, {
      schedules: [mkSchedule(), mkSchedule({ id: 's2', taskName: 'sync-other' })],
      hasMore: false,
      error: '',
      tasks: [],
      form: null,
      editingId: null,
    });
    const text = out.querySelector('table')?.textContent ?? '';
    expect(text).toContain('pause');
    expect(text).toContain('edit');
    expect(text).toContain('delete');
    // happy-dom drops <td> wrappers from lit templates (see runs-list.test.ts) —
    // the table-cell fix is pinned via the shared style rule; row-height
    // geometry was verified by the admin in a real browser (retest 16:46Z).
    expect(shared.cssText).toContain('.actions { vertical-align: middle; white-space: nowrap; }');
  });

  it('rejects invalid JSON data in the form with a clear error (no request sent)', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const el = stateful(SchedSchedules.prototype, {
      base: '/api',
      token: undefined,
      refreshMs: 0,
      limit: 50,
      offset: 0,
      schedules: [],
      hasMore: false,
      error: '',
      tasks: [],
      form: {
        taskName: 't',
        kind: 'cron',
        value: '0 9 * * *',
        tz: '',
        data: '{nope',
        externalId: '',
        dedupKey: '',
        retry: '',
        priority: '',
        error: '',
      },
      editingId: null,
    }) as unknown as { saveForm(): Promise<void>; form: { error: string } };
    await el.saveForm();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(el.form.error).toContain('invalid JSON');
  });
});
