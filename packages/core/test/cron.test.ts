import { describe, expect, it } from 'vitest';
import { nextRun } from '../src/cron.js';

const at = (iso: string) => Date.parse(iso);

describe('nextRun', () => {
  it('returns the next minute boundary for every-minute cron, from mid-minute', () => {
    expect(nextRun('* * * * *', new Date('2026-08-15T12:00:30Z')).getTime()).toBe(at('2026-08-15T12:01:00Z'));
  });

  it('returns strictly-after: from exactly on the boundary schedules the next one', () => {
    expect(nextRun('* * * * *', new Date('2026-08-15T12:00:00Z')).getTime()).toBe(at('2026-08-15T12:01:00Z'));
  });

  it('returns same time next day for daily cron (UTC default)', () => {
    expect(nextRun('0 9 * * *', new Date('2026-08-15T09:00:00Z')).getTime()).toBe(at('2026-08-16T09:00:00Z'));
  });

  it('skips to the next hour when the current hour has passed', () => {
    expect(nextRun('0 * * * *', new Date('2026-08-15T10:30:00Z')).getTime()).toBe(at('2026-08-15T11:00:00Z'));
  });

  it('interprets cron in the given timezone: Moscow 09:00 = 06:00 UTC', () => {
    expect(nextRun('0 9 * * *', new Date('2026-08-15T10:00:00Z'), { tz: 'Europe/Moscow' }).getTime()).toBe(
      at('2026-08-16T06:00:00Z'),
    );
  });

  it('skips a nonexistent local time across DST spring-forward (Europe/Berlin 2026-03-29)', () => {
    // 2026-03-29 02:00 CET → 03:00 CEST: "30 2 * * *" (02:30) does not exist that day.
    // Next valid 02:30 local = 2026-03-30 02:30 CEST = 2026-03-30T00:30Z.
    expect(nextRun('30 2 * * *', new Date('2026-03-28T23:00:00Z'), { tz: 'Europe/Berlin' }).getTime()).toBe(
      at('2026-03-30T00:30:00Z'),
    );
  });

  it('fires once across DST fall-back (Europe/Berlin 2026-10-25): first 02:30 CEST', () => {
    // 2026-10-25 03:00 CEST → 02:00 CET: 02:30 local occurs twice.
    // from = 2026-10-24T23:30:00Z (= 2026-10-25 01:30 CEST) → first 02:30 CEST = 2026-10-25T00:30Z.
    expect(nextRun('30 2 * * *', new Date('2026-10-24T23:30:00Z'), { tz: 'Europe/Berlin' }).getTime()).toBe(
      at('2026-10-25T00:30:00Z'),
    );
  });
});
