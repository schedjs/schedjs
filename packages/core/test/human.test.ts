import { describe, expect, it } from 'vitest';
import { parseSchedule, ScheduleParseError } from '../src/human.js';

const NOW = new Date('2026-08-15T12:00:00Z');

describe('parseSchedule — cron passthrough', () => {
  it('passes through a 5-field cron expression', () => {
    expect(parseSchedule('0 9 * * *', { now: NOW })).toEqual({ kind: 'cron', cron: '0 9 * * *' });
  });

  it('passes through a 6-field cron expression (seconds)', () => {
    expect(parseSchedule('*/30 * * * * *', { now: NOW })).toEqual({ kind: 'cron', cron: '*/30 * * * * *' });
  });
});

describe('parseSchedule — intervals (our grammar, en v1)', () => {
  it('parses "every 5 minutes"', () => {
    expect(parseSchedule('every 5 minutes', { now: NOW })).toEqual({ kind: 'interval', ms: 300_000 });
  });

  it('parses bare "5 minutes" without the "every" prefix', () => {
    expect(parseSchedule('5 minutes', { now: NOW })).toEqual({ kind: 'interval', ms: 300_000 });
  });

  it('parses "every hour" as 1 hour without a number', () => {
    expect(parseSchedule('every hour', { now: NOW })).toEqual({ kind: 'interval', ms: 3_600_000 });
  });

  it('parses "a minute" / "an hour" articles', () => {
    expect(parseSchedule('a minute', { now: NOW })).toEqual({ kind: 'interval', ms: 60_000 });
    expect(parseSchedule('an hour', { now: NOW })).toEqual({ kind: 'interval', ms: 3_600_000 });
  });

  it('parses days and weeks', () => {
    expect(parseSchedule('every 2 days', { now: NOW })).toEqual({ kind: 'interval', ms: 172_800_000 });
    expect(parseSchedule('1 week', { now: NOW })).toEqual({ kind: 'interval', ms: 604_800_000 });
  });

  it('rejects unknown units with a clear error', () => {
    expect(() => parseSchedule('every 5 fortnights', { now: NOW })).toThrow(ScheduleParseError);
  });

  it('rejects zero/negative quantities', () => {
    expect(() => parseSchedule('every 0 minutes', { now: NOW })).toThrow(ScheduleParseError);
  });
});

describe('parseSchedule — one-shot (chrono contract, pinned)', () => {
  it('"tomorrow at noon" → next day 12:00 UTC (default tz)', () => {
    expect(parseSchedule('tomorrow at noon', { now: NOW })).toEqual({
      kind: 'once',
      at: new Date('2026-08-16T12:00:00Z'),
    });
  });

  it('"at 14:00" with tz UTC → same day 14:00Z (not machine-local!)', () => {
    expect(parseSchedule('at 14:00', { now: NOW, tz: 'UTC' })).toEqual({
      kind: 'once',
      at: new Date('2026-08-15T14:00:00Z'),
    });
  });

  it('"at 14:00" with tz Europe/Moscow → 14:00 Moscow = 11:00Z; now is 15:00 MSK, so next occurrence is tomorrow', () => {
    // now = 2026-08-15T12:00Z = 15:00 MSK → today 14:00 already passed → forwardDate: tomorrow
    expect(parseSchedule('at 14:00', { now: NOW, tz: 'Europe/Moscow' })).toEqual({
      kind: 'once',
      at: new Date('2026-08-16T11:00:00Z'),
    });
  });

  it('"in 3 hours" → now + 3h (tz-independent)', () => {
    expect(parseSchedule('in 3 hours', { now: NOW })).toEqual({ kind: 'once', at: new Date('2026-08-15T15:00:00Z') });
  });
});

describe('parseSchedule — recurrence guard (v1: recurring wall-clock is cron territory)', () => {
  it('rejects "daily at 9am" instead of silently making it a one-shot', () => {
    expect(() => parseSchedule('daily at 9am', { now: NOW })).toThrow(ScheduleParseError);
  });

  it('rejects "every monday at 9am"', () => {
    expect(() => parseSchedule('every monday at 9am', { now: NOW })).toThrow(ScheduleParseError);
  });
});

describe('parseSchedule — garbage', () => {
  it('rejects nonsense with a grammar error', () => {
    expect(() => parseSchedule('banana', { now: NOW })).toThrow(ScheduleParseError);
  });
});
