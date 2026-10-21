/** Founder-facing times are Beijing time (UTC+8, no DST): "2026-10-20 11:31". Unparseable input is returned as is. */
export function founderBeijingTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed + 8 * 60 * 60 * 1_000).toISOString().slice(0, 16).replace('T', ' ');
}
