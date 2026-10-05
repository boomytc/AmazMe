const MAX_RETRY_AFTER_MS = 120_000;

const DAY = "Mon|Tue|Wed|Thu|Fri|Sat|Sun";
const WEEKDAY = "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday";
const MONTH = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
const TIME = "\\d{2}:\\d{2}:\\d{2}";

/**
 * Retry-After is delay-seconds or an HTTP-date (IMF-fixdate, RFC 850, or asctime).
 * `Date.parse("1.5")` is a real timestamp, so a value that is not one of those
 * three date shapes is left unset instead of being treated as a date.
 * asctime has no zone token, but RFC 9110 still means GMT. `Date.parse` reads
 * "Thu Oct 15 17:00:15 2026" as local time, so Asia/Shanghai shifts it eight
 * hours and the clamp turns the delay into 0 or 120s. That shape is parsed as GMT.
 * The delta is milliseconds from now, clamped to 0..120_000.
 */
const ASCTIME_SHAPE = `(?:${DAY}) (?:${MONTH}) (?: \\d|\\d{2}) ${TIME} \\d{4}`;
const HTTP_DATE = new RegExp(
  `^(?:(?:${DAY}), \\d{2} (?:${MONTH}) \\d{4} ${TIME} GMT|(?:${WEEKDAY}), \\d{2}-(?:${MONTH})-\\d{2} ${TIME} GMT|${ASCTIME_SHAPE})$`,
);
const ASCTIME = new RegExp(`^${ASCTIME_SHAPE}$`);

export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (value.length === 0) return undefined;
  if (/^\d+$/.test(value)) {
    const ms = Number(value) * 1000;
    if (!Number.isFinite(ms)) return MAX_RETRY_AFTER_MS;
    return clamp(ms);
  }
  if (!HTTP_DATE.test(value)) return undefined;
  const parsed = ASCTIME.test(value) ? Date.parse(`${value} GMT`) : Date.parse(value);
  if (Number.isNaN(parsed)) return undefined;
  return clamp(parsed - now);
}

function clamp(ms: number): number {
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms));
}
