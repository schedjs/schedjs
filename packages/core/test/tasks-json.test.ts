import { join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadTasksJson, readTasksJsonAlertsSync, readTasksJsonRunnersSync, readTasksJsonTaskAlertsSync, syncTasks, toSchedules, toTasks } from '../src/tasks-json.js';
import type { TaskDefinition } from '../src/tasks-json.js';
import { MemoryStorage } from './helpers/memory-storage.js';

const NOON = new Date('2026-08-16T12:00:00Z');

/** Cast for deliberately-invalid shapes (runtime validation is the point). */
const asDef = (d: unknown) => d as TaskDefinition;

const defs: TaskDefinition[] = [
  {
    name: 'sync',
    schedules: [{ interval: 'every 5 minutes' }],
    config: { url: 'http://worker:3000/tasks/sync' },
  },
  {
    name: 'daily',
    schedules: [{ cron: '0 9 * * *' }],
    tz: 'Europe/Moscow',
    config: { url: 'http://worker:3000/tasks/daily' },
  },
  {
    name: 'launch',
    schedules: [{ once: 'tomorrow at noon' }],
    config: { url: 'http://worker:3000/tasks/launch' },
  },
];

describe('toTasks', () => {
  it('parses keyed schedules and computes initial nextRunAt', () => {
    const tasks = toTasks(defs, NOON);
    expect(tasks).toHaveLength(3);

    const sync = tasks[0]!;
    expect(sync.schedule).toEqual({ kind: 'interval', ms: 300_000 });
    expect(sync.nextRunAt!.getTime()).toBe(Date.parse('2026-08-16T12:05:00Z'));

    const daily = tasks[1]!;
    expect(daily.schedule).toEqual({ kind: 'cron', cron: '0 9 * * *' });
    expect(daily.tz).toBe('Europe/Moscow');
    // 09:00 Moscow = 06:00 UTC, next from 12:00Z → tomorrow 06:00Z
    expect(daily.nextRunAt!.getTime()).toBe(Date.parse('2026-08-17T06:00:00Z'));

    const launch = tasks.find((t) => t.name === 'launch')!;
    expect(launch.schedule).toEqual({ kind: 'once', at: new Date('2026-08-17T12:00:00Z') });
    expect(launch.nextRunAt!.getTime()).toBe(Date.parse('2026-08-17T12:00:00Z'));
  });

  it('rejects the legacy schedule key with a fail-fast hint (decision 2026-08-18: cut legacy)', () => {
    expect(() =>
      toTasks([asDef({ name: 'legacy', schedule: { cron: '0 9 * * *' }, config: { url: 'http://x' } })], NOON),
    ).toThrow(/use "schedules"/i);
  });

  it('hoists timezone inside a cron schedule to tz (books parity)', () => {
    const t = toTasks(
      [{ name: 'msk', schedules: [{ cron: '0 9 * * *', timezone: 'Europe/Moscow' }], config: { url: 'http://x/tasks/msk' } }],
      NOON,
    )[0]!;
    expect(t.tz).toBe('Europe/Moscow');
  });

  it('rejects timezone on non-cron schedules', () => {
    expect(() =>
      toTasks([asDef({ name: 'bad', schedules: [{ interval: 'every 5 minutes', timezone: 'UTC' }], config: {} })], NOON),
    ).toThrow(/timezone/i);
  });

  it('hoists the schedule timezone over the task-level tz (inner wins, r8 #4 F1)', () => {
    expect(() =>
      toTasks(
        [asDef({ name: 'bad', schedules: [{ cron: '0 9 * * *', timezone: 'Europe/Moscow' }], tz: 'UTC', config: { url: 'http://x' } })],
        NOON,
      ),
    ).not.toThrow();
    const t = toTasks(
      [asDef({ name: 'bad', schedules: [{ cron: '0 9 * * *', timezone: 'Europe/Moscow' }], tz: 'UTC', config: { url: 'http://x' } })],
      NOON,
    )[0]!;
    // docs 03.tasks: task tz "applies to schedules that don't set their own" —
    // an entry that sets its own timezone wins (hoisted), never a 400 conflict.
    expect(t.tz).toBe('Europe/Moscow');
  });

  it('rejects schedule elements with zero, multiple, or unknown keys', () => {
    expect(() => toTasks([asDef({ name: 'a', schedules: [{}], config: {} })], NOON)).toThrow(/exactly one/i);
    expect(() =>
      toTasks(
        [asDef({ name: 'b', schedules: [{ cron: '0 9 * * *', interval: 'every 5 minutes' }], config: {} })],
        NOON,
      ),
    ).toThrow(/exactly one/i);
    expect(() => toTasks([asDef({ name: 'c', schedules: [{ banana: 'x' }], config: {} })], NOON)).toThrow(/exactly one/i);
  });

  it('rejects schedule key/value mismatch (cron key but interval value)', () => {
    expect(() => toTasks([asDef({ name: 'bad', schedules: [{ cron: 'every 5 minutes' }], config: {} })], NOON)).toThrow(
      /cron/i,
    );
  });

  it('defaults runner to http and passes through explicit runner', () => {
    const tasks = toTasks(
      [
        { name: 'a', schedules: [{ cron: '0 9 * * *' }], config: { url: 'http://x/tasks/a' } },
        { name: 'b', runner: 'docker', schedules: [{ cron: '0 9 * * *' }], config: { image: 'busybox' } },
      ],
      NOON,
    );
    expect(tasks[0]!.runner).toBe('http');
    expect(tasks[1]!.runner).toBe('docker');
  });

  it('validates http config: url is required and must be a non-empty string', () => {
    expect(() => toTasks([{ name: 'a', schedules: [{ cron: '0 9 * * *' }], config: {} }], NOON)).toThrow(/url/i);
    expect(() => toTasks([{ name: 'a', schedules: [{ cron: '0 9 * * *' }], config: { url: '' } }], NOON)).toThrow(/url/i);
    expect(() =>
      toTasks([{ name: 'a', schedules: [{ cron: '0 9 * * *' }], config: { url: 42 } }], NOON),
    ).toThrow(/url/i);
  });

  it('validates http config: timeoutMs positive number, headers object', () => {
    expect(() =>
      toTasks([{ name: 'a', schedules: [{ cron: '0 9 * * *' }], config: { url: 'http://x', timeoutMs: -5 } }], NOON),
    ).toThrow(/timeoutMs/i);
    expect(() =>
      toTasks([{ name: 'a', schedules: [{ cron: '0 9 * * *' }], config: { url: 'http://x', headers: 'nope' } }], NOON),
    ).toThrow(/headers/i);
    expect(() =>
      toTasks(
        [{ name: 'a', schedules: [{ cron: '0 9 * * *' }], config: { url: 'http://x', timeoutMs: 1000, headers: { a: 'b' } } }],
        NOON,
      ),
    ).not.toThrow();
  });

  it('accepts task-level timeoutMs: -1 (never auto-terminate — manual cancel only)', () => {
    const tasks = toTasks([{ name: 'a', schedules: [{ cron: '0 9 * * *' }], config: { url: 'http://x' }, timeoutMs: -1 }], NOON);
    expect(tasks[0]!.timeoutMs).toBe(-1);
  });

  it('accepts a positive task-level timeoutMs (force-fail deadline)', () => {
    const tasks = toTasks(
      [{ name: 'a', schedules: [{ cron: '0 9 * * *' }], config: { url: 'http://x' }, timeoutMs: 3_600_000 }],
      NOON,
    );
    expect(tasks[0]!.timeoutMs).toBe(3_600_000);
  });

  it('defaults task-level timeoutMs to -1 when absent (never auto-terminate)', () => {
    const tasks = toTasks([{ name: 'a', schedules: [{ cron: '0 9 * * *' }], config: { url: 'http://x' } }], NOON);
    expect(tasks[0]!.timeoutMs).toBe(-1);
  });

  it('rejects task-level timeoutMs: 0, negatives other than -1, NaN, and strings', () => {
    const base = { name: 'a', schedules: [{ cron: '0 9 * * *' }], config: { url: 'http://x' } };
    expect(() => toTasks([{ ...base, timeoutMs: 0 }], NOON)).toThrow(/timeoutMs/i);
    expect(() => toTasks([{ ...base, timeoutMs: -2 }], NOON)).toThrow(/timeoutMs/i);
    expect(() => toTasks([asDef({ ...base, timeoutMs: 'fast' })], NOON)).toThrow(/timeoutMs/i);
    expect(() => toTasks([{ ...base, timeoutMs: Number.NaN }], NOON)).toThrow(/timeoutMs/i);
  });

  it('validates docker config: image is required', () => {
    expect(() =>
      toTasks([{ name: 'a', runner: 'docker', schedules: [{ cron: '0 9 * * *' }], config: {} }], NOON),
    ).toThrow(/image/i);
  });

  it('validates http config: auth needs a non-empty apiKey, header must be a string', () => {
    const base = { name: 'a', schedules: [{ cron: '0 9 * * *' }], config: { url: 'http://x' } };
    expect(() => toTasks([{ ...base, config: { url: 'http://x', auth: {} } }], NOON)).toThrow(/apiKey/i);
    expect(() => toTasks([{ ...base, config: { url: 'http://x', auth: { apiKey: '' } } }], NOON)).toThrow(/apiKey/i);
    expect(() => toTasks([{ ...base, config: { url: 'http://x', auth: 'nope' } }], NOON)).toThrow(/auth/i);
    expect(() =>
      toTasks([{ ...base, config: { url: 'http://x', auth: { apiKey: 'k', header: 42 } } }], NOON),
    ).toThrow(/header/i);
    expect(() => toTasks([{ ...base, config: { url: 'http://x', auth: { apiKey: 'k' } } }], NOON)).not.toThrow();
    expect(() =>
      toTasks([{ ...base, config: { url: 'http://x', auth: { apiKey: 'k', header: 'x-worker-token' } } }], NOON),
    ).not.toThrow();
  });

  it('does not shape-validate unknown runner names (custom runner seam)', () => {
    const t = toTasks(
      [{ name: 'a', runner: 'in-process', schedules: [{ cron: '0 9 * * *' }], config: { anything: true } }],
      NOON,
    )[0]!;
    expect(t.runner).toBe('in-process');
  });

  it('passes priority and retry policy through to TaskRecord', () => {
    const t = toTasks(
      [
        {
          name: 'a',
          priority: 7,
          retry: { maxAttempts: 3, backoffMs: 5000, multiplier: 2 },
          schedules: [{ cron: '0 9 * * *' }],
          config: { url: 'http://x' },
        },
      ],
      NOON,
    )[0]!;
    expect(t.priority).toBe(7);
    expect(t.retry).toEqual({ maxAttempts: 3, backoffMs: 5000, multiplier: 2 });
    expect(t.retryCount).toBe(0);
  });

  it('passes inputSchema through to TaskRecord and applies defaults to entry data (task:1658)', () => {
    const t = toTasks(
      [
        {
          name: 'a',
          inputSchema: {
            type: 'object',
            properties: { idSeller: { type: 'integer', minimum: 1 }, mode: { type: 'string', default: 'auto' } },
            required: ['idSeller'],
          },
          schedules: [{ cron: '0 9 * * *', data: { idSeller: 2 } }],
          config: { url: 'http://x' },
        },
      ],
      NOON,
    )[0]!;
    expect(t.inputSchema).toEqual({
      type: 'object',
      properties: { idSeller: { type: 'integer', minimum: 1 }, mode: { type: 'string', default: 'auto' } },
      required: ['idSeller'],
    });
    // schedule data has defaults materialized (the effective data contract)
    const s = toSchedules(
      [
        {
          name: 'a',
          inputSchema: {
            type: 'object',
            properties: { idSeller: { type: 'integer' }, mode: { type: 'string', default: 'auto' } },
            required: ['idSeller'],
          },
          schedules: [{ cron: '0 9 * * *', data: { idSeller: 2 } }],
          config: { url: 'http://x' },
        },
      ],
      NOON,
    )[0]!;
    expect(s.data).toEqual({ idSeller: 2, mode: 'auto' });
  });

  it('rejects a malformed inputSchema with a descriptive error (fail-fast at load)', () => {
    expect(() =>
      toTasks([{ name: 'a', inputSchema: { type: 'objectish' }, schedules: [], config: { url: 'http://x' } }], NOON),
    ).toThrow(/inputSchema.*type/);
  });

  it('rejects schedule data that violates the task inputSchema (fail-fast at load)', () => {
    expect(() =>
      toTasks(
        [
          {
            name: 'a',
            inputSchema: { type: 'object', properties: { idSeller: { type: 'integer' } }, required: ['idSeller'] },
            schedules: [{ cron: '0 9 * * *', data: { idSeller: 'nope' } }],
            config: { url: 'http://x' },
          },
        ],
        NOON,
      ),
    ).toThrow(/inputSchema/);
  });

  it('defaults priority to 0 and retry to null when omitted', () => {
    const t = toTasks([{ name: 'a', schedules: [{ cron: '0 9 * * *' }], config: { url: 'http://x' } }], NOON)[0]!;
    expect(t.priority).toBe(0);
    expect(t.retry).toBeNull();
  });

  it('accepts a task without schedules (trigger-only): schedule null, nextRunAt null', () => {
    const t = toTasks([{ name: 'manual-only', config: { url: 'http://x/tasks/delete' } }], NOON)[0]!;
    expect(t.schedule).toBeNull();
    expect(t.nextRunAt).toBeNull();
    expect(t.tz).toBe('UTC');
    expect(t.runner).toBe('http');
  });

  it('a multi-schedule task drives its PRIMARY (first) schedule on the task row until slice 2', () => {
    const t = toTasks(
      [
        {
          name: 'multi',
          schedules: [
            { cron: '0 9 * * *', data: { idSeller: 2 } },
            { interval: 'every 5 minutes', data: { idSeller: 3 } },
          ],
          config: { url: 'http://x' },
        },
      ],
      NOON,
    )[0]!;
    expect(t.schedule).toEqual({ kind: 'cron', cron: '0 9 * * *' }); // first entry
  });

  it('validates retry policy fail-fast: maxAttempts >= 1, backoffMs >= 0, multiplier >= 1', () => {
    const base = { name: 'a', schedules: [{ cron: '0 9 * * *' }], config: { url: 'http://x' } };
    expect(() => toTasks([{ ...base, retry: { maxAttempts: 0, backoffMs: 100 } }], NOON)).toThrow(/maxAttempts/);
    expect(() => toTasks([{ ...base, retry: { maxAttempts: 1.5, backoffMs: 100 } }], NOON)).toThrow(/maxAttempts/);
    expect(() => toTasks([{ ...base, retry: { maxAttempts: 2, backoffMs: -5 } }], NOON)).toThrow(/backoffMs/);
    expect(() => toTasks([{ ...base, retry: { maxAttempts: 2, backoffMs: 100, multiplier: 0.5 } }], NOON)).toThrow(/multiplier/);
    expect(() => toTasks([{ ...base, retry: { maxAttempts: 2 } as never }], NOON)).toThrow(/backoffMs/);
  });

  it('validates priority fail-fast: non-negative integer', () => {
    const base = { name: 'a', schedules: [{ cron: '0 9 * * *' }], config: { url: 'http://x' } };
    expect(() => toTasks([{ ...base, priority: -1 }], NOON)).toThrow(/priority/);
    expect(() => toTasks([{ ...base, priority: 1.5 }], NOON)).toThrow(/priority/);
    expect(() => toTasks([{ ...base, priority: 'high' as never }], NOON)).toThrow(/priority/);
  });

  it('validates per-entry tenant fields and policy fail-fast', () => {
    const base = { name: 'a', config: { url: 'http://x' } };
    expect(() => toTasks([{ ...base, schedules: [{ cron: '0 9 * * *', externalId: '' }] }], NOON)).toThrow(/externalId/);
    expect(() => toTasks([{ ...base, schedules: [{ cron: '0 9 * * *', dedupKey: 7 as never }] }], NOON)).toThrow(/dedupKey/);
    expect(() =>
      toTasks([{ ...base, schedules: [{ cron: '0 9 * * *', priority: -2 }] }], NOON),
    ).toThrow(/priority/);
    expect(() =>
      toTasks([{ ...base, schedules: [{ cron: '0 9 * * *', retry: { maxAttempts: 0, backoffMs: 1 } }] }], NOON),
    ).toThrow(/maxAttempts/);
  });

  it('rejects duplicate dedupKey across the file (fail-fast before the UNIQUE constraint)', () => {
    expect(() =>
      toTasks(
        [
          { name: 'a', schedules: [{ cron: '0 9 * * *', dedupKey: 'seller-2' }], config: { url: 'http://x' } },
          { name: 'b', schedules: [{ interval: 'every 5 minutes', dedupKey: 'seller-2' }], config: { url: 'http://y' } },
        ],
        NOON,
      ),
    ).toThrow(/duplicate schedules.dedupKey/i);
  });

  it('passes label and description through to TaskRecord', () => {
    const t = toTasks(
      [
        {
          name: 'a',
          label: 'FBS: резерв',
          description: 'Раз в сутки резервирует отправления',
          schedules: [{ cron: '0 9 * * *' }],
          config: { url: 'http://x' },
        },
      ],
      NOON,
    )[0]!;
    expect(t.label).toBe('FBS: резерв');
    expect(t.description).toBe('Раз в сутки резервирует отправления');
  });
});

describe('toSchedules', () => {
  it('builds one ScheduleRecord per schedules element with deterministic ids (single = task name)', () => {
    const out = toSchedules(defs, NOON);
    expect(out).toHaveLength(3);

    const sync = out.find((s) => s.id === 'sync')!;
    expect(sync.taskName).toBe('sync');
    expect(sync.schedule).toEqual({ kind: 'interval', ms: 300_000 });
    expect(sync.tz).toBe('UTC');
    expect(sync.nextRunAt!.getTime()).toBe(Date.parse('2026-08-16T12:05:00Z'));
    expect(sync.fileManaged).toBe(true);

    const daily = out.find((s) => s.id === 'daily')!;
    expect(daily.schedule).toEqual({ kind: 'cron', cron: '0 9 * * *' });
    expect(daily.tz).toBe('Europe/Moscow');
  });

  it('multi-schedule task: ids are name#index (idempotent re-sync), single is the task name', () => {
    const out = toSchedules(
      [
        {
          name: 'multi',
          schedules: [
            { cron: '0 9 * * *', data: { idSeller: 2 } },
            { interval: 'every 5 minutes', data: { idSeller: 3 } },
          ],
          config: { url: 'http://x' },
        },
      ],
      NOON,
    );
    expect(out.map((s) => s.id)).toEqual(['multi#0', 'multi#1']);
    expect(out[0]!.data).toEqual({ idSeller: 2 });
    expect(out[1]!.data).toEqual({ idSeller: 3 });
    // stable across calls — re-sync upserts, never duplicates
    expect(toSchedules(
      [
        {
          name: 'multi',
          schedules: [
            { cron: '0 9 * * *', data: { idSeller: 2 } },
            { interval: 'every 5 minutes', data: { idSeller: 3 } },
          ],
          config: { url: 'http://x' },
        },
      ],
      NOON,
    ).map((s) => s.id)).toEqual(['multi#0', 'multi#1']);
  });

  it('inherits the task-level priority when the entry does not override it (F1)', () => {
    const s = toSchedules(
      [{ name: 'prio', priority: 10, schedules: [{ cron: '0 9 * * *' }], config: { url: 'http://x' } }],
      NOON,
    )[0]!;
    // effective policy materialized at sync (entry ?? task default) — an entry
    // without priority must carry the task's 10, not a collapsed 0 (F1).
    expect(s.priority).toBe(10);
  });

  it('keeps retry inheritance intact alongside priority inheritance (F1 regression)', () => {
    const s = toSchedules(
      [
        {
          name: 'prio',
          priority: 10,
          retry: { maxAttempts: 2, backoffMs: 1000 },
          schedules: [{ cron: '0 9 * * *' }],
          config: { url: 'http://x' },
        },
      ],
      NOON,
    )[0]!;
    expect(s.priority).toBe(10);
    expect(s.retry).toEqual({ maxAttempts: 2, backoffMs: 1000 });
  });

  it('carries tenant fields and per-schedule policy onto the ScheduleRecord', () => {
    const s = toSchedules(
      [
        {
          name: 'seller',
          schedules: [
            {
              cron: '0 9 * * *',
              data: { idSeller: 2 },
              externalId: 'tenant-7',
              dedupKey: 'seller-2',
              retry: { maxAttempts: 3, backoffMs: 60_000 },
              priority: 5,
            },
          ],
          config: { url: 'http://x' },
        },
      ],
      NOON,
    )[0]!;
    expect(s.id).toBe('seller');
    expect(s.externalId).toBe('tenant-7');
    expect(s.dedupKey).toBe('seller-2');
    expect(s.retry).toEqual({ maxAttempts: 3, backoffMs: 60_000 });
    expect(s.priority).toBe(5);
    expect(s.data).toEqual({ idSeller: 2 });
  });

  it('a trigger-only task (no schedules) yields no ScheduleRecords', () => {
    expect(toSchedules([{ name: 'manual-only', config: { url: 'http://x' } }], NOON)).toEqual([]);
  });
});

describe('loadTasksJson', () => {
  it('loads a tasks.json file and validates unique names', async () => {
    const tasks = await loadTasksJson(fileURLToPath(new URL('./fixtures/tasks.json', import.meta.url)));
    expect(tasks.map((t) => t.name)).toEqual(['sync', 'daily']);
    expect(tasks[0]!.runner).toBe('http');
    expect(tasks[0]!.label).toBe('Sync');
  });

  it('readTasksJsonRunnersSync reads the runners block (sandbox ceilings)', async () => {
    const runners = readTasksJsonRunnersSync(fileURLToPath(new URL('./fixtures/tasks.json', import.meta.url)));
    expect(runners).toEqual({});

    // write a temp file with a runners block
    const dir = fileURLToPath(new URL('./fixtures', import.meta.url));
    const tmp = join(dir, 'tmp-runners.json');
    writeFileSync(
      tmp,
      JSON.stringify({
        runners: { process: { allowedTools: ['node'] }, docker: { allowedTools: ['alpine@echo'] } },
        tasks: [],
      }),
    );
    try {
      expect(readTasksJsonRunnersSync(tmp)).toEqual({
        process: { allowedTools: ['node'] },
        docker: { allowedTools: ['alpine@echo'] },
      });
    } finally {
      rmSync(tmp, { force: true });
    }
  });

  it('readTasksJsonRunnersSync rejects malformed ceilings and tolerates a missing file', () => {
    const dir = fileURLToPath(new URL('./fixtures', import.meta.url));
    const tmp = join(dir, 'tmp-runners-bad.json');
    writeFileSync(tmp, JSON.stringify({ runners: { process: { allowedTools: 'node' } }, tasks: [] }));
    try {
      expect(() => readTasksJsonRunnersSync(tmp)).toThrow(/allowedTools/);
    } finally {
      rmSync(tmp, { force: true });
    }
    expect(readTasksJsonRunnersSync(join(dir, 'nope-missing.json'))).toEqual({});
  });
  it('readTasksJsonAlertsSync reads the top-level alerts block (webhook config)', () => {
    const dir = fileURLToPath(new URL('./fixtures', import.meta.url));
    const tmp = join(dir, 'tmp-alerts.json');
    writeFileSync(
      tmp,
      JSON.stringify({
        tasks: [],
        alerts: { webhook: { url: 'https://hooks.example.com/sched', secret: 'whsec_1' }, onMissed: false },
      }),
    );
    try {
      expect(readTasksJsonAlertsSync(tmp)).toEqual({
        webhook: { url: 'https://hooks.example.com/sched', secret: 'whsec_1' },
        onMissed: false,
      });
    } finally {
      rmSync(tmp, { force: true });
    }
  });

  it('readTasksJsonAlertsSync returns undefined without an alerts block or a file', () => {
    const dir = fileURLToPath(new URL('./fixtures', import.meta.url));
    // fixture has no alerts block
    expect(readTasksJsonAlertsSync(fileURLToPath(new URL('./fixtures/tasks.json', import.meta.url)))).toBeUndefined();
    expect(readTasksJsonAlertsSync(join(dir, 'nope-missing.json'))).toBeUndefined();
  });

  it('readTasksJsonAlertsSync rejects a malformed (non-object) alerts block', () => {
    const dir = fileURLToPath(new URL('./fixtures', import.meta.url));
    const tmp = join(dir, 'tmp-alerts-bad.json');
    writeFileSync(tmp, JSON.stringify({ tasks: [], alerts: 'nope' }));
    try {
      expect(() => readTasksJsonAlertsSync(tmp)).toThrow(/alerts/);
    } finally {
      rmSync(tmp, { force: true });
    }
  });

  it('readTasksJsonTaskAlertsSync folds tasks[].alerts into a per-task routing map', () => {
    const dir = fileURLToPath(new URL('./fixtures', import.meta.url));
    const tmp = join(dir, 'tmp-task-alerts.json');
    writeFileSync(
      tmp,
      JSON.stringify({
        tasks: [
          { name: 'a', config: { url: 'http://a' }, alerts: { on: [] } },
          { name: 'b', config: { url: 'http://b' }, alerts: { onMissed: false } },
          { name: 'c', config: { url: 'http://c' }, alerts: { webhook: { url: 'https://hooks.example.com/pd' } } },
          { name: 'plain', config: { url: 'http://plain' } },
        ],
      }),
    );
    try {
      expect(readTasksJsonTaskAlertsSync(tmp)).toEqual({
        a: { on: [] },
        b: { onMissed: false },
        c: { webhook: { url: 'https://hooks.example.com/pd' } },
      });
    } finally {
      rmSync(tmp, { force: true });
    }
  });

  it('readTasksJsonTaskAlertsSync returns {} without task alerts or a file', () => {
    const dir = fileURLToPath(new URL('./fixtures', import.meta.url));
    expect(readTasksJsonTaskAlertsSync(fileURLToPath(new URL('./fixtures/tasks.json', import.meta.url)))).toEqual({});
    expect(readTasksJsonTaskAlertsSync(join(dir, 'nope-missing.json'))).toEqual({});
  });

  it('readTasksJsonTaskAlertsSync rejects malformed task alerts (fail-fast)', () => {
    const dir = fileURLToPath(new URL('./fixtures', import.meta.url));
    const cases = [
      [{ name: 'a', config: { url: 'http://a' }, alerts: 'nope' }, /alerts/],
      [{ name: 'a', config: { url: 'http://a' }, alerts: { on: 'failed' } }, /on/],
      [{ name: 'a', config: { url: 'http://a' }, alerts: { on: ['boom'] } }, /boom/],
      [{ name: 'a', config: { url: 'http://a' }, alerts: { onMissed: 'yes' } }, /onMissed/],
      [{ name: 'a', config: { url: 'http://a' }, alerts: { webhook: { url: 42 } } }, /webhook/],
    ];
    for (const [task, re] of cases) {
      const tmp = join(dir, 'tmp-task-alerts-bad.json');
      writeFileSync(tmp, JSON.stringify({ tasks: [task] }));
      try {
        expect(() => readTasksJsonTaskAlertsSync(tmp)).toThrow(re as RegExp);
      } finally {
        rmSync(tmp, { force: true });
      }
    }
  });
});

describe('syncTasks', () => {
  it('creates missing tasks AND their schedules, and keeps runtime state of existing ones', async () => {
    const storage = new MemoryStorage();
    await syncTasks(storage, defs, NOON);

    expect((await storage.getTask('sync'))!.schedule).toEqual({ kind: 'interval', ms: 300_000 });
    expect((await storage.getTask('daily'))!.tz).toBe('Europe/Moscow');
    expect((await storage.getTask('daily'))!.runner).toBe('http');

    const sched = (await storage.getSchedule('sync'))!;
    expect(sched.schedule).toEqual({ kind: 'interval', ms: 300_000 });
    expect(sched.taskName).toBe('sync');

    // re-sync: schedule unchanged → nextRunAt preserved (task and schedule);
    // config updated
    const before = (await storage.getTask('sync'))!;
    const schedBefore = (await storage.getSchedule('sync'))!;
    await syncTasks(
      storage,
      [
        {
          name: 'sync',
          schedules: [{ interval: 'every 5 minutes' }],
          config: { url: 'http://worker:3000/tasks/sync-v2' },
        },
      ],
      NOON,
    );
    const after = (await storage.getTask('sync'))!;
    expect(after.nextRunAt).toEqual(before.nextRunAt);
    expect(after.config).toEqual({ url: 'http://worker:3000/tasks/sync-v2' });
    expect((await storage.getSchedule('sync'))!.nextRunAt).toEqual(schedBefore.nextRunAt);
    // single schedule → exactly one row for the task, no duplicates on re-sync
    expect(await storage.listSchedules({ taskName: 'sync' })).toHaveLength(1);
  });

  it('recomputes nextRunAt when the schedule changes (task and schedule rows)', async () => {
    const storage = new MemoryStorage();
    await syncTasks(storage, defs, NOON);
    const before = (await storage.getTask('sync'))!;

    await syncTasks(
      storage,
      [{ name: 'sync', schedules: [{ interval: 'every 10 minutes' }], config: { url: 'http://worker:3000/tasks/sync' } }],
      NOON,
    );

    const after = (await storage.getTask('sync'))!;
    expect(after.schedule).toEqual({ kind: 'interval', ms: 600_000 });
    expect(after.nextRunAt!.getTime()).toBe(Date.parse('2026-08-16T12:10:00Z'));
    expect(after.nextRunAt).not.toEqual(before.nextRunAt);
    expect((await storage.getSchedule('sync'))!.nextRunAt!.getTime()).toBe(Date.parse('2026-08-16T12:10:00Z'));
  });

  it('updates runner/label/description on existing tasks', async () => {
    const storage = new MemoryStorage();
    await syncTasks(storage, defs, NOON);

    await syncTasks(
      storage,
      [
        {
          name: 'daily',
          runner: 'http',
          label: 'Daily!',
          description: 'd',
          schedules: [{ cron: '0 9 * * *' }],
          tz: 'Europe/Moscow',
          config: { url: 'http://worker:3000/tasks/daily' },
        },
      ],
      NOON,
    );
    const t = (await storage.getTask('daily'))!;
    expect(t.label).toBe('Daily!');
    expect(t.description).toBe('d');
    expect(t.runner).toBe('http');
  });

  it('applies timeoutMs from tasks.json to an existing task (regression: field dropped on upsert)', async () => {
    const storage = new MemoryStorage();
    // a task that already exists in storage WITHOUT a deadline — e.g. created
    // before timeoutMs existed, or synced by an older core (0.45.0 bug: applyTask
    // never wrote the field, so the stored value stayed null)
    await storage.upsertTask({
      ...(await toTasks(
        [{ name: 'sync', schedules: [{ interval: 'every 5 minutes' }], config: { url: 'http://x' } }],
        NOON,
      ))[0]!,
      timeoutMs: null,
    });

    // re-sync with an explicit deadline in the file → the value must land
    await syncTasks(
      storage,
      [{ name: 'sync', schedules: [{ interval: 'every 5 minutes' }], config: { url: 'http://x' }, timeoutMs: 3_600_000 }],
      NOON,
    );
    expect((await storage.getTask('sync'))!.timeoutMs).toBe(3_600_000);

    // and an explicit -1 sticks too
    await syncTasks(
      storage,
      [{ name: 'sync', schedules: [{ interval: 'every 5 minutes' }], config: { url: 'http://x' }, timeoutMs: -1 }],
      NOON,
    );
    expect((await storage.getTask('sync'))!.timeoutMs).toBe(-1);

    // absent in the file = -1 default (never auto-terminate) — the operator
    // contract: no need to write timeoutMs for the safe default
    await syncTasks(storage, [{ name: 'sync', schedules: [{ interval: 'every 5 minutes' }], config: { url: 'http://x' } }], NOON);
    expect((await storage.getTask('sync'))!.timeoutMs).toBe(-1);
  });

  it('does not touch runtime pause/disabled flags (task or schedule)', async () => {
    const storage = new MemoryStorage();
    await syncTasks(storage, defs, NOON);
    await storage.upsertTask({ ...(await storage.getTask('sync'))!, paused: true });
    await storage.updateSchedule('sync', { paused: true });

    await syncTasks(storage, defs, NOON);

    expect((await storage.getTask('sync'))!.paused).toBe(true);
    expect((await storage.getSchedule('sync'))!.paused).toBe(true);
  });

  it('disables schedules removed from tasks.json (kept in history, never fire again)', async () => {
    const storage = new MemoryStorage();
    await syncTasks(storage, defs, NOON);
    // 'daily' is dropped from the desired state — its task AND its schedule disable
    await syncTasks(storage, [defs[0]!, defs[2]!], NOON);

    const removed = await storage.getTask('daily');
    expect(removed!.disabled).toBe(true); // doc promise: removed task → disabled
    expect(removed!.name).toBe('daily'); // kept in history, not deleted
    const sched = await storage.getSchedule('daily');
    expect(sched!.disabled).toBe(true); // same contract for schedules
    // no longer due — a zombie schedule must not keep ticking
    const due = await storage.listDueTasks(new Date('2030-01-01T00:00:00Z'));
    expect(due.map((t) => t.name)).not.toContain('daily');
    // tasks still in the file are untouched
    expect((await storage.getTask('sync'))!.disabled).toBe(false);
    expect((await storage.getSchedule('sync'))!.disabled).toBe(false);
  });

  it('a multi-schedule task stores every schedule row, each with its own data', async () => {
    const storage = new MemoryStorage();
    await syncTasks(
      storage,
      [
        {
          name: 'multi',
          schedules: [
            { cron: '0 9 * * *', data: { idSeller: 2 } },
            { interval: 'every 5 minutes', data: { idSeller: 3 } },
          ],
          config: { url: 'http://x' },
        },
      ],
      NOON,
    );
    const all = await storage.listSchedules({ taskName: 'multi' });
    expect(all.map((s) => s.id)).toEqual(['multi#0', 'multi#1']);
    expect(all.map((s) => s.data)).toEqual([{ idSeller: 2 }, { idSeller: 3 }]);
  });

  it('marks file schedules fileManaged and never disables runtime-registered ones (r7 F1 parity)', async () => {
    const storage = new MemoryStorage();
    await syncTasks(storage, defs, NOON);

    // file schedules are managed by tasks.json
    expect((await storage.getSchedule('sync'))!.fileManaged).toBe(true);

    // runtime-registered schedule (what POST /schedules does later): fileManaged = false
    await storage.createSchedule({
      id: 'rt-sched',
      taskName: 'sync',
      schedule: { kind: 'interval', ms: 60_000 },
      tz: 'UTC',
      data: null,
      externalId: null,
      dedupKey: null,
      nextRunAt: new Date('2026-08-16T12:01:00Z'),
      lastRunAt: null,
      lockedAt: null,
      failCount: 0,
      priority: 0,
      retry: null,
      retryCount: 0,
      lastRunId: null,
      paused: false,
      disabled: false,
      fileManaged: false,
    });

    await syncTasks(storage, defs, NOON); // live sync — runtime schedule must survive
    expect((await storage.getSchedule('rt-sched'))!.disabled).toBe(false);

    // a file-managed schedule removed from the file is still disabled (unchanged contract)
    await syncTasks(storage, [defs[0]!, defs[2]!], NOON);
    expect((await storage.getSchedule('daily'))!.disabled).toBe(true);
    expect((await storage.getSchedule('rt-sched'))!.disabled).toBe(false);
  });

  it('never re-enables a schedule — sync flips disabled only on removal', async () => {
    const storage = new MemoryStorage();
    await syncTasks(storage, defs, NOON);
    await storage.updateSchedule('sync', { disabled: true });

    await syncTasks(storage, defs, NOON);

    expect((await storage.getSchedule('sync'))!.disabled).toBe(true);
  });

  it('syncs a trigger-only task (no schedules): visible, never due, schedule stays null on re-sync', async () => {
    const storage = new MemoryStorage();
    await syncTasks(storage, [{ name: 'manual-only', config: { url: 'http://x/tasks/delete' } }], NOON);

    const t = await storage.getTask('manual-only');
    expect(t!.schedule).toBeNull();
    expect(t!.nextRunAt).toBeNull();
    expect((await storage.listTasks()).map((x) => x.name)).toEqual(['manual-only']); // visible in lists
    expect(await storage.listDueTasks(new Date('2030-01-01T00:00:00Z'))).toHaveLength(0); // never due
    expect(await storage.listSchedules()).toHaveLength(0); // no schedule rows

    // re-sync preserves the trigger-only shape
    await syncTasks(storage, [{ name: 'manual-only', config: { url: 'http://x/tasks/delete' } }], NOON);
    const after = await storage.getTask('manual-only');
    expect(after!.schedule).toBeNull();
    expect(after!.nextRunAt).toBeNull();
  });
});

describe('syncTasks — tz-only change (peer-review regression)', () => {
  it('recomputes nextRunAt when only tz changed (same cron)', async () => {
    const storage = new MemoryStorage();
    const defs = [asDef({ name: 'daily', schedules: [{ cron: '0 9 * * *' }], tz: 'Europe/Moscow', config: { url: 'http://w' } })];
    await syncTasks(storage, defs, NOON);
    const first = await storage.getTask('daily');
    expect(first!.tz).toBe('Europe/Moscow');

    // same cron, different tz — nextRunAt must be recomputed from the new wall-clock
    const newNext = new Date('2026-08-17T00:00:00Z');
    await syncTasks(storage, [asDef({ name: 'daily', schedules: [{ cron: '0 9 * * *' }], tz: 'Asia/Tokyo', config: { url: 'http://w' }, nextRunAt: newNext })], NOON);
    const after = await storage.getTask('daily');
    expect(after!.tz).toBe('Asia/Tokyo');
    expect(after!.nextRunAt).toEqual(newNext);
  });
});

describe('tasks.json — alerts block validation (R1 streak)', () => {
  const dir = fileURLToPath(new URL('./fixtures', import.meta.url));
  const tmpPath = () => join(dir, 'tmp-alerts-streak.json');

  const withFile = <T,>(doc: unknown, fn: (path: string) => T): T => {
    const tmp = tmpPath();
    writeFileSync(tmp, JSON.stringify(doc));
    try {
      return fn(tmp);
    } finally {
      rmSync(tmp, { force: true });
    }
  };

  it('accepts a valid root onStreak and passes it through', () => {
    const alerts = withFile({ tasks: [], alerts: { onStreak: 3, onSyncFailed: false } }, (p) => readTasksJsonAlertsSync(p));
    expect(alerts).toEqual({ onStreak: 3, onSyncFailed: false });
  });

  it('accepts a valid per-task onStreak (1 = the default, explicitly allowed)', () => {
    const map = withFile(
      { tasks: [{ name: 'a', config: { url: 'http://a' }, alerts: { onStreak: 2 } }, { name: 'b', config: { url: 'http://b' }, alerts: { onStreak: 1 } }] },
      (p) => readTasksJsonTaskAlertsSync(p),
    );
    expect(map).toEqual({ a: { onStreak: 2 }, b: { onStreak: 1 } });
  });

  it('rejects a malformed per-task onStreak (string / 0 / negative / fractional)', () => {
    for (const onStreak of ['3', 0, -1, 2.5]) {
      const tmp = tmpPath();
      writeFileSync(tmp, JSON.stringify({ tasks: [{ name: 'a', config: { url: 'http://a' }, alerts: { onStreak } }] }));
      try {
        expect(() => readTasksJsonTaskAlertsSync(tmp)).toThrow(/onStreak/);
      } finally {
        rmSync(tmp, { force: true });
      }
    }
  });

  it('rejects a malformed per-task onSyncFailed (previously not validated at all)', () => {
    expect(() =>
      withFile({ tasks: [{ name: 'a', config: { url: 'http://a' }, alerts: { onSyncFailed: 'yes' } }] }, (p) =>
        readTasksJsonTaskAlertsSync(p),
      ),
    ).toThrow(/onSyncFailed/);
  });

  it('rejects a malformed root alerts block (the hole that let anything through)', () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ onStreak: '3' }, /onStreak/],
      [{ onStreak: 0 }, /onStreak/],
      [{ onSyncFailed: 'yes' }, /onSyncFailed/],
      [{ on: 'failed' }, /alerts"\.on/],
      [{ on: ['boom'] }, /boom/],
      [{ onMissed: 1 }, /onMissed/],
      [{ webhook: { url: 42 } }, /webhook/],
      [{ webhook: 'http://x' }, /webhook/],
    ];
    for (const [alerts, re] of cases) {
      expect(() => withFile({ tasks: [], alerts }, (p) => readTasksJsonAlertsSync(p))).toThrow(re);
    }
  });

  it('validates the per-task map nested in the root alerts block too', () => {
    expect(() =>
      withFile({ tasks: [], alerts: { webhook: { url: 'http://x' }, tasks: { a: { onStreak: -2 } } } }, (p) =>
        readTasksJsonAlertsSync(p),
      ),
    ).toThrow(/onStreak/);
  });
});
