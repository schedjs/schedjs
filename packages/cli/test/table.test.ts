import { describe, expect, it } from 'vitest';
import { formatTable, humanDuration, shortTime } from '../src/table.js';

describe('table helpers', () => {
  it('shortTime renders UTC with an explicit Z marker (F9)', () => {
    expect(shortTime('2026-08-18T17:13:00.000Z')).toBe('2026-08-18 17:13:00Z');
    expect(shortTime(null)).toBe('—');
    expect(shortTime('not-a-date')).toBe('not-a-date');
  });

  it('humanDuration: ms/s/m/h/d', () => {
    expect(humanDuration(500)).toBe('500ms');
    expect(humanDuration(42_000)).toBe('42s');
    expect(humanDuration(2 * 60_000)).toBe('2m');
    expect(humanDuration(3 * 3_600_000)).toBe('3h');
    expect(humanDuration(5 * 86_400_000)).toBe('5d');
    expect(humanDuration(null)).toBe('—');
  });

  it('formatTable pads and joins', () => {
    expect(formatTable(['A', 'B'], [['x', 'yy'], ['zzz', 'w']])).toContain('zzz');
  });
});
