/**
 * `--date=relative` — git's `show_date_relative` cascade: seconds → minutes →
 * hours → days → weeks → months → years, each rounded the way git rounds
 * (`(x + half) / unit`), with the 1–5 year band rendered as
 * `N years, M months ago`. `now` is supplied by the caller (git reads the wall
 * clock); the value is therefore not byte-pinnable by interop.
 */

const HALF_MINUTE = 30;
const HALF_HOUR_IN_MINUTES = 30;
const HALF_DAY_IN_HOURS = 12;
const SECONDS_CUTOFF = 90;
const MINUTES_CUTOFF = 90;
const HOURS_CUTOFF = 36;
const DAYS_CUTOFF = 14;
const WEEKS_CUTOFF = 70; // days
const MONTHS_CUTOFF = 365; // days
const YEARS_CUTOFF = 1825; // days (5 years)

const unit = (count: number, name: string): string =>
  `${count} ${name}${count === 1 ? '' : 's'} ago`;

const yearsAndMonths = (years: number, months: number): string =>
  `${years} year${years === 1 ? '' : 's'}, ${months} month${months === 1 ? '' : 's'} ago`;

export function formatRelativeDate(then: number, now: number): string {
  if (now < then) return 'in the future';
  const seconds = now - then;
  if (seconds < SECONDS_CUTOFF) return unit(seconds, 'second');

  const minutes = Math.floor((seconds + HALF_MINUTE) / 60);
  if (minutes < MINUTES_CUTOFF) return unit(minutes, 'minute');

  const hours = Math.floor((minutes + HALF_HOUR_IN_MINUTES) / 60);
  if (hours < HOURS_CUTOFF) return unit(hours, 'hour');

  const days = Math.floor((hours + HALF_DAY_IN_HOURS) / 24);
  if (days < DAYS_CUTOFF) return unit(days, 'day');
  if (days < WEEKS_CUTOFF) return unit(Math.floor((days + 3) / 7), 'week');
  if (days < MONTHS_CUTOFF) return unit(Math.floor((days + 15) / 30), 'month');

  if (days < YEARS_CUTOFF) {
    const totalMonths = Math.floor((days * 12 * 2 + 365) / (365 * 2));
    const years = Math.floor(totalMonths / 12);
    const months = totalMonths % 12;
    return months === 0 ? unit(years, 'year') : yearsAndMonths(years, months);
  }
  return unit(Math.floor((days + 183) / 365), 'year');
}
