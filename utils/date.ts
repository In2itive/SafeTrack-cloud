/**
 * Format a date-only string ("2026-11-13") as a local date.
 * `new Date("2026-11-13")` is parsed as midnight UTC, which displays as the
 * previous day anywhere west of UTC (e.g. Toronto), so build it locally.
 */
export function formatDate(value?: string | null): string {
  if (!value) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return new Date(value).toLocaleDateString();
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString();
}
