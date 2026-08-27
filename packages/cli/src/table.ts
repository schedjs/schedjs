/**
 * Minimal TTY table rendering for @schedjs/cli. Plain-text aligned columns;
 * degrades gracefully (no colors) when stdout is not a TTY or NO_COLOR is set.
 * Machine output is `--json`, never this.
 */

export interface TableOptions {
  /** Column alignments; default: all left. */
  align?: Array<'left' | 'right'>;
}

export function formatTable(headers: string[], rows: string[][], opts: TableOptions = {}): string {
  const cols = headers.length;
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (cell: string, i: number): string => {
    const w = widths[i] ?? 0;
    const align = opts.align?.[i] === 'right' ? cell.padStart(w) : cell.padEnd(w);
    return align;
  };
  const lines = [headers.map(fmt).join('  ').replace(/\s+$/, '')];
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) lines.push(row.map(fmt).join('  ').replace(/\s+$/, ''));
  return lines.join('\n');
}

/** ANSI colors — only when stdout is a TTY and NO_COLOR is unset. */
export function colorEnabled(stream: { isTTY?: boolean } = process.stdout): boolean {
  return Boolean(stream.isTTY) && !('NO_COLOR' in process.env);
}

const COLORS: Record<string, string> = {
  green: '\u001b[32m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  dim: '\u001b[2m',
  reset: '\u001b[0m',
};

export function paint(text: string, color: keyof typeof COLORS, enabled = colorEnabled()): string {
  return enabled ? `${COLORS[color]}${text}${COLORS.reset}` : text;
}

/** Human-friendly duration: 42s, 2m, 3h, 5d. Null-safe. */
export function humanDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/** Short UTC timestamp — ISO without milliseconds, explicit Z marker (F9: the
 *  value was UTC but undecorated, so an operator read 17:13 as local 17:13). */
export function shortTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 19).replace('T', ' ') + 'Z';
}

const str = (v: unknown): string => (v === null || v === undefined ? '—' : String(v));

/** A record's field by key with a fallback for missing values. */
export function field(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  return v === null || v === undefined ? '—' : str(v);
}
