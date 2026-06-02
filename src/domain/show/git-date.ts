/**
 * Render a git identity timestamp in the default `medium` / `DATE_NORMAL`
 * format: `Wed Nov 15 00:13:20 2023 +0200`. The wall-clock components are the
 * UTC components of `timestamp + offset`, so the time is shown in the
 * identity's own zone independent of the host clock; the offset string is
 * printed verbatim.
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
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

const pad2 = (value: number): string => String(value).padStart(2, '0');

const offsetSeconds = (timezoneOffset: string): number => {
  const sign = timezoneOffset.startsWith('-') ? -1 : 1;
  const hours = Number(timezoneOffset.slice(1, 3));
  const minutes = Number(timezoneOffset.slice(3, 5));
  return sign * (hours * SECONDS_PER_HOUR + minutes * SECONDS_PER_MINUTE);
};

export function formatGitDate(timestamp: number, timezoneOffset: string): string {
  const local = new Date((timestamp + offsetSeconds(timezoneOffset)) * 1000);
  const weekday = WEEKDAYS[local.getUTCDay()];
  const month = MONTHS[local.getUTCMonth()];
  const day = local.getUTCDate();
  const time = `${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}:${pad2(local.getUTCSeconds())}`;
  return `${weekday} ${month} ${day} ${time} ${local.getUTCFullYear()} ${timezoneOffset}`;
}
