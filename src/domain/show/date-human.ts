/**
 * `--date=human` — git's contextual format. Observed against real git:
 *   - same calendar day      → the relative form (`5 hours ago`)
 *   - same year, ≤5 days ago,
 *     same month             → `Wed 10:18` (weekday + time)
 *   - same year, otherwise   → `Sat May 30 21:18` (weekday + month + day + time)
 *   - different year         → `Nov 14 2025` (month + day + year)
 * `now` is supplied by the caller, so the value is not byte-pinnable by interop.
 * Both ends are bucketed in the identity's own zone (best-effort port — git
 * buckets in the host zone; documented divergence).
 */
import { MONTHS, pad2, WEEKDAYS, wallClockParts } from './date-parts.js';
import { formatRelativeDate } from './date-relative.js';

const RECENT_DAYS = 5;

export function formatHumanDate(then: number, timezoneOffset: string, now: number): string {
  const t = wallClockParts(then, timezoneOffset);
  const n = wallClockParts(now, timezoneOffset);
  if (t.year === n.year && t.monthIndex === n.monthIndex && t.day === n.day) {
    return formatRelativeDate(then, now);
  }
  if (t.year !== n.year) {
    return `${MONTHS[t.monthIndex]} ${t.day} ${t.year}`;
  }
  const time = `${pad2(t.hours)}:${pad2(t.minutes)}`;
  const daysAgo = n.day - t.day;
  if (t.monthIndex === n.monthIndex && daysAgo >= 1 && daysAgo <= RECENT_DAYS) {
    return `${WEEKDAYS[t.weekdayIndex]} ${time}`;
  }
  return `${WEEKDAYS[t.weekdayIndex]} ${MONTHS[t.monthIndex]} ${t.day} ${time}`;
}
