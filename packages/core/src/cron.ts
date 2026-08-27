import { CronExpressionParser } from 'cron-parser';

export interface NextRunOptions {
  /** IANA timezone name, e.g. 'Europe/Moscow'. Default: 'UTC' — deterministic, machine-independent. */
  tz?: string;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock components of `date` in the given IANA timezone. */
function wallParts(date: Date, tz: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  let fmt = formatterCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(tz, fmt);
  }
  const parts = fmt.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
}

const validatorCache = new Map<string, ReturnType<typeof CronExpressionParser.parse>>();

/**
 * Compute the next run time strictly after `from` for a 5-field cron expression.
 *
 * Semantics (pinned by tests):
 * - Returns the first moment strictly after `from` matching the expression.
 * - If `tz` is given, the expression is interpreted in that IANA timezone.
 * - DST spring-forward: a nonexistent local time is skipped (next valid occurrence).
 * - DST fall-back: a repeated local time fires once, at the first occurrence.
 *
 * DST guard: cron-parser resolves a DST-shifted wall time with a possibly stale
 * offset (e.g. '30 2 * * *' on Berlin 2026-03-29 yields 03:30 CEST, not 02:30).
 * Each candidate is validated against the expression parsed in UTC (offset-free):
 * if the candidate's wall-clock in `tz` doesn't match the cron fields, skip it.
 */
export function nextRun(cron: string, from: Date, options: NextRunOptions = {}): Date {
  const tz = options.tz ?? 'UTC';
  const expr = CronExpressionParser.parse(cron, { currentDate: from, tz });

  let validator = validatorCache.get(cron);
  if (!validator) {
    validator = CronExpressionParser.parse(cron, { tz: 'UTC' });
    validatorCache.set(cron, validator);
  }

  for (;;) {
    const candidate = expr.next().toDate();
    const p = wallParts(candidate, tz);
    const naiveAsUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    if (validator.includesDate(new Date(naiveAsUtc))) {
      return candidate;
    }
  }
}
