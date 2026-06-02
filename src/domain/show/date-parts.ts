/**
 * Shared calendar-component extraction for the date formatters. `wallClockParts`
 * shifts the UTC instant by the identity's stored offset and reads UTC getters,
 * so the components are the time in the identity's own zone (host-independent);
 * `localClockParts` reads local getters, so they reflect the host zone
 * (`--date=local`). The struct carries indices; callers name them through
 * `WEEKDAYS`/`MONTHS` in template literals.
 */

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;

export const pad2 = (value: number): string => String(value).padStart(2, '0');

export const offsetSeconds = (timezoneOffset: string): number => {
  const sign = timezoneOffset.startsWith('-') ? -1 : 1;
  const hours = Number(timezoneOffset.slice(1, 3));
  const minutes = Number(timezoneOffset.slice(3, 5));
  return sign * (hours * SECONDS_PER_HOUR + minutes * SECONDS_PER_MINUTE);
};

export interface DateParts {
  readonly weekdayIndex: number;
  readonly monthIndex: number;
  readonly day: number;
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
  readonly year: number;
}

/** Components of `timestamp` in the identity's own zone. */
export const wallClockParts = (timestamp: number, timezoneOffset: string): DateParts => {
  const local = new Date((timestamp + offsetSeconds(timezoneOffset)) * 1000);
  return {
    weekdayIndex: local.getUTCDay(),
    monthIndex: local.getUTCMonth(),
    day: local.getUTCDate(),
    hours: local.getUTCHours(),
    minutes: local.getUTCMinutes(),
    seconds: local.getUTCSeconds(),
    year: local.getUTCFullYear(),
  };
};

/** Components of `timestamp` in the host zone (`--date=local`). */
export const localClockParts = (timestamp: number): DateParts => {
  const d = new Date(timestamp * 1000);
  return {
    weekdayIndex: d.getDay(),
    monthIndex: d.getMonth(),
    day: d.getDate(),
    hours: d.getHours(),
    minutes: d.getMinutes(),
    seconds: d.getSeconds(),
    year: d.getFullYear(),
  };
};
