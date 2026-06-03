/**
 * Render a git identity timestamp in the default `medium` / `DATE_NORMAL`
 * format: `Wed Nov 15 00:13:20 2023 +0200`. The wall-clock components are the
 * UTC components of `timestamp + offset`, so the time is shown in the
 * identity's own zone independent of the host clock; the offset string is
 * printed verbatim.
 */
import { MONTHS, pad2, WEEKDAYS, wallClockParts } from './date-parts.js';

export function formatGitDate(timestamp: number, timezoneOffset: string): string {
  const p = wallClockParts(timestamp, timezoneOffset);
  const time = `${pad2(p.hours)}:${pad2(p.minutes)}:${pad2(p.seconds)}`;
  return `${WEEKDAYS[p.weekdayIndex]} ${MONTHS[p.monthIndex]} ${p.day} ${time} ${p.year} ${timezoneOffset}`;
}
