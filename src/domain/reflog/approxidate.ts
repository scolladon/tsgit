/**
 * A subset of git's approxidate grammar, shared by `<ref>@{<date>}` resolution
 * and `reflog expire`. Pure: `(text, now) => unix-seconds | undefined`.
 *
 * ISO absolute forms are interpreted in the host's local timezone, constructed
 * from calendar components — matching git, which never uses a UTC date-only
 * parse. Relative forms are timezone-agnostic (a delta from `now`).
 */

const SECONDS_PER_UNIT: Readonly<Record<string, number>> = {
  second: 1,
  minute: 60,
  hour: 3_600,
  day: 86_400,
  week: 604_800,
  // Approximate, as in git's relative-date arithmetic.
  month: 2_592_000,
  year: 31_536_000,
};

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?$/;
const RELATIVE_RE = /^(\d+)[ .]([a-z]+?)s?(?:[ .]ago)?$/;
const DAY_SECONDS = 86_400;

/** Resolve an approximate-date string to unix seconds. `undefined` = unparseable. */
export function parseApproxidate(text: string, now: number): number | undefined {
  const normalized = text.trim().toLowerCase();
  if (normalized === 'now') return now;
  if (normalized === 'yesterday') return now - DAY_SECONDS;
  return parseIso(normalized) ?? parseRelative(normalized, now);
}

function parseIso(text: string): number | undefined {
  const match = ISO_RE.exec(text);
  if (match === null) return undefined;
  const [, y, mo, d, h, mi, s] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = h === undefined ? 0 : Number(h);
  const minute = mi === undefined ? 0 : Number(mi);
  const secondOfMinute = s === undefined ? 0 : Number(s);
  // Reject out-of-range components explicitly — `new Date` would silently
  // roll them over (month 13 -> next January) rather than fail.
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysInMonth(year, month)) return undefined;
  if (hour > 23) return undefined;
  if (minute > 59) return undefined;
  if (secondOfMinute > 59) return undefined;
  const date = new Date(year, month - 1, day, hour, minute, secondOfMinute);
  return Math.floor(date.getTime() / 1000);
}

// 30/31-day months plus February's leap-year length; index 0 is January.
const MONTH_LENGTHS: ReadonlyArray<number> = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return MONTH_LENGTHS[month - 1] as number;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function parseRelative(text: string, now: number): number | undefined {
  const match = RELATIVE_RE.exec(text);
  if (match === null) return undefined;
  const [, count, unit] = match;
  const secondsPerUnit = SECONDS_PER_UNIT[unit as string];
  if (secondsPerUnit === undefined) return undefined;
  return now - Number(count) * secondsPerUnit;
}
