/**
 * Minimal `strftime` for `--date=format:<spec>` and the `%ad`/`%cd` format
 * placeholders. Operates on the identity's own-zone wall clock (git's `format:`
 * uses the commit zone; `format-local:` is out of scope). Supports the common
 * conversions; an unrecognised `%X` is emitted verbatim (`%X`), never dropped.
 */
import { MONTHS, pad2, WEEKDAYS, wallClockParts } from './date-parts.js';

const FULL_WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;
const FULL_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const hour12 = (hours: number): number => {
  const h = hours % 12;
  return h === 0 ? 12 : h;
};

export function strftime(format: string, timestamp: number, timezoneOffset: string): string {
  const p = wallClockParts(timestamp, timezoneOffset);
  const conversions: Record<string, string> = {
    Y: String(p.year),
    y: pad2(p.year % 100),
    m: pad2(p.monthIndex + 1),
    d: pad2(p.day),
    e: String(p.day).padStart(2, ' '),
    H: pad2(p.hours),
    I: pad2(hour12(p.hours)),
    M: pad2(p.minutes),
    S: pad2(p.seconds),
    p: p.hours < 12 ? 'AM' : 'PM',
    // Indices come from Date getters (always in range); the template literal
    // coerces the `string | undefined` element type without an unreachable branch.
    a: `${WEEKDAYS[p.weekdayIndex]}`,
    A: `${FULL_WEEKDAYS[p.weekdayIndex]}`,
    b: `${MONTHS[p.monthIndex]}`,
    h: `${MONTHS[p.monthIndex]}`,
    B: `${FULL_MONTHS[p.monthIndex]}`,
    z: timezoneOffset,
    n: '\n',
    t: '\t',
    '%': '%',
  };
  let out = '';
  for (let i = 0; i < format.length; i += 1) {
    if (format[i] !== '%' || i + 1 >= format.length) {
      out += format[i];
      continue;
    }
    const spec = format[i + 1] as string;
    const replacement = conversions[spec];
    out += replacement !== undefined ? replacement : `%${spec}`;
    i += 1;
  }
  return out;
}
