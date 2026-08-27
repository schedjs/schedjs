/**
 * Effective auto-refresh interval from a `?refresh=` query value.
 * - absent or non-numeric → `fallback`
 * - `0` stays `0` (polling off — 0 is a valid number, must not fall back)
 *   (F&F r3 admin note: `Number('0') || fallback` fell through to the default,
 *   so `?refresh=0` could not disable polling.)
 *
 * Pure + browser-safe (no node imports) — lives in the bundle, used by the
 * morda script at runtime.
 */
export function refreshFromSearch(search: string, fallback: number): number {
  const raw = new URLSearchParams(search).get('refresh');
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isNaN(n) ? fallback : n;
}
