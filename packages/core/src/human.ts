import { CronExpressionParser } from 'cron-parser';
import * as chrono from 'chrono-node';

export type Schedule =
  | { kind: 'cron'; cron: string }
  | { kind: 'interval'; ms: number }
  | { kind: 'once'; at: Date };

export class ScheduleParseError extends Error {
  constructor(input: string) {
    super(
      `Unrecognized schedule "${input}". Supported forms: ` +
        'cron ("0 9 * * *"), interval ("every 5 minutes"), ' +
        'or a date/time ("tomorrow at noon", "in 3 hours"). ' +
        'Recurring wall-clock phrases ("daily at 9am") are not supported yet — use cron.',
    );
    this.name = 'ScheduleParseError';
  }
}

export interface ParseScheduleOptions {
  /** Reference moment for relative phrases. Default: now. */
  now?: Date;
  /** IANA timezone for wall-clock phrases. Default: 'UTC'. */
  tz?: string;
}

// "every 5 minutes" | "5 minutes" | "every hour" | "a minute" | "an hour"
const INTERVAL_RE =
  /^(?:every\s+)?(?:(?:(\d+))|(?:a|an))?\s*(second|minute|hour|day|week)s?$/i;

const UNIT_MS = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
} as const;

// Recurring wall-clock phrases we deliberately do NOT map to one-shots in v1.
const RECURRING_RE =
  /^(?:daily|weekly|monthly|yearly|hourly|every\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;

/** Interval-shaped but invalid input ("every 5 fortnights", "every 0 minutes"). */
const INTERVAL_SHAPE_RE = /^(?:every\s+)?(?:\d+|a|an)?\s*[a-z]+\s*$/i;

function tryInterval(input: string): number | null {
  const m = input.match(INTERVAL_RE);
  if (!m) return null;
  const n = m[1] ? Number.parseInt(m[1], 10) : 1;
  if (n < 1) throw new ScheduleParseError(input);
  const unit = m[2]!.toLowerCase() as keyof typeof UNIT_MS;
  return n * UNIT_MS[unit];
}

function tryCron(input: string): string | null {
  try {
    CronExpressionParser.parse(input);
    return input;
  } catch {
    return null;
  }
}

/**
 * chrono-node interprets wall-clock phrases in the machine's local timezone and
 * its `timezone` option is ignored (verified 2.10.1). Wrap the synchronous parse
 * in a TZ env set/restore so "at 14:00" means 14:00 in the schedule's tz, not the
 * host's. Node is single-threaded and the parse is synchronous — no interleaving.
 */
function tryOnce(input: string, now: Date, tz: string): Date | null {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return chrono.en.parseDate(input, now, { forwardDate: true }) ?? null;
  } finally {
    if (prev === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = prev;
    }
  }
}

/**
 * Parse a human-readable schedule into a normalized {@link Schedule}.
 *
 * Classification order (critical — chrono would swallow "every 5 minutes" as a
 * one-shot point):
 *   1. cron expression (5/6-field) → `{ kind: 'cron' }`
 *   2. recurrence guard: "daily at 9am" / "every monday" → error (v1: use cron)
 *   3. interval grammar → `{ kind: 'interval', ms }`
 *   4. chrono one-shot (TZ-wrapped, forwardDate) → `{ kind: 'once', at }`
 *   5. anything else → {@link ScheduleParseError}
 */
export function parseSchedule(input: string, options: ParseScheduleOptions = {}): Schedule {
  const text = input.trim();
  const now = options.now ?? new Date();
  const tz = options.tz ?? 'UTC';

  const cron = tryCron(text);
  if (cron) return { kind: 'cron', cron };

  if (RECURRING_RE.test(text)) throw new ScheduleParseError(text);

  const interval = tryInterval(text);
  if (interval !== null) return { kind: 'interval', ms: interval };

  if (INTERVAL_SHAPE_RE.test(text)) throw new ScheduleParseError(text);

  const at = tryOnce(text, now, tz);
  if (at) return { kind: 'once', at };

  throw new ScheduleParseError(text);
}
