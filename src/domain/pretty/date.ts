export type DateMode =
  | 'normal'
  | 'rfc2822'
  | 'relative'
  | 'iso8601'
  | 'iso8601-strict'
  | 'short'
  | 'human';

const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MILLIS_PER_SECOND = 1000;
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

interface Civil {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly weekday: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const civilAt = (timestamp: number, offsetMinutes: number): Civil => {
  const shifted = new Date((timestamp + offsetMinutes * SECONDS_PER_MINUTE) * MILLIS_PER_SECOND);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
};

const pad2 = (value: number): string => String(value).padStart(2, '0');

const hoursOf = (offsetMinutes: number): number =>
  Math.floor(Math.abs(offsetMinutes) / MINUTES_PER_HOUR);

const minutesOf = (offsetMinutes: number): number => Math.abs(offsetMinutes) % MINUTES_PER_HOUR;

const signOf = (offsetMinutes: number): string => (offsetMinutes < 0 ? '-' : '+');

const zoneCompact = (offsetMinutes: number): string =>
  `${signOf(offsetMinutes)}${pad2(hoursOf(offsetMinutes))}${pad2(minutesOf(offsetMinutes))}`;

const zoneStrict = (offsetMinutes: number): string =>
  offsetMinutes === 0
    ? 'Z'
    : `${signOf(offsetMinutes)}${pad2(hoursOf(offsetMinutes))}:${pad2(minutesOf(offsetMinutes))}`;

const dayOf = (civil: Civil): string =>
  `${String(civil.year).padStart(4, '0')}-${pad2(civil.month + 1)}-${pad2(civil.day)}`;

const clockOf = (civil: Civil): string =>
  `${pad2(civil.hour)}:${pad2(civil.minute)}:${pad2(civil.second)}`;

const showNormal = (civil: Civil, tz: number): string =>
  `${WEEKDAYS[civil.weekday]} ${MONTHS[civil.month]} ${civil.day} ${clockOf(civil)} ${civil.year} ${zoneCompact(tz)}`;

const showRfc2822 = (civil: Civil, tz: number): string =>
  `${WEEKDAYS[civil.weekday]}, ${civil.day} ${MONTHS[civil.month]} ${civil.year} ${clockOf(civil)} ${zoneCompact(tz)}`;

const HOURS_PER_DAY = 24;
const DAYS_PER_YEAR = 365;
const DAYS_PER_WEEK = 7;
const DAYS_PER_MONTH = 30;
const MONTHS_PER_YEAR = 12;
const SECONDS_BEFORE_MINUTES = 90;
const MINUTES_BEFORE_HOURS = 90;
const HOURS_BEFORE_DAYS = 36;
const DAYS_BEFORE_WEEKS = 14;
const DAYS_BEFORE_MONTHS = 70;
const DAYS_BEFORE_YEARS = DAYS_PER_YEAR;
const DAYS_BEFORE_ROUNDED_YEARS = 1825;
const HALF_MINUTE = 30;
const HALF_DAY_IN_HOURS = 12;
const WEEK_ROUNDING = 3;
const MONTH_ROUNDING = 15;
const HALF_YEAR = 183;

const plural = (count: number, unit: string): string => `${count} ${unit}${count === 1 ? '' : 's'}`;

const roundedDivide = (value: number, unit: number, half: number): number =>
  Math.floor((value + half) / unit);

const relativeYears = (days: number): string => {
  if (days >= DAYS_BEFORE_ROUNDED_YEARS) {
    return plural(roundedDivide(days, DAYS_PER_YEAR, HALF_YEAR), 'year');
  }
  const totalMonths = Math.floor(
    (days * MONTHS_PER_YEAR * 2 + DAYS_PER_YEAR) / (DAYS_PER_YEAR * 2),
  );
  const years = Math.floor(totalMonths / MONTHS_PER_YEAR);
  const months = totalMonths % MONTHS_PER_YEAR;
  return months === 0
    ? plural(years, 'year')
    : `${plural(years, 'year')}, ${plural(months, 'month')}`;
};

const relativeDays = (days: number): string => {
  if (days < DAYS_BEFORE_WEEKS) return plural(days, 'day');
  if (days < DAYS_BEFORE_MONTHS)
    return plural(roundedDivide(days, DAYS_PER_WEEK, WEEK_ROUNDING), 'week');
  if (days < DAYS_BEFORE_YEARS)
    return plural(roundedDivide(days, DAYS_PER_MONTH, MONTH_ROUNDING), 'month');
  return relativeYears(days);
};

const showRelative = (timestamp: number, nowSeconds: number): string => {
  if (nowSeconds < timestamp) return 'in the future';
  const seconds = nowSeconds - timestamp;
  if (seconds < SECONDS_BEFORE_MINUTES) return `${plural(seconds, 'second')} ago`;
  const minutes = roundedDivide(seconds, SECONDS_PER_MINUTE, HALF_MINUTE);
  if (minutes < MINUTES_BEFORE_HOURS) return `${plural(minutes, 'minute')} ago`;
  const hours = roundedDivide(minutes, MINUTES_PER_HOUR, HALF_MINUTE);
  if (hours < HOURS_BEFORE_DAYS) return `${plural(hours, 'hour')} ago`;
  return `${relativeDays(roundedDivide(hours, HOURS_PER_DAY, HALF_DAY_IN_HOURS))} ago`;
};

const DAYS_SHOWN_AS_WEEKDAY = 5;

interface Hidden {
  readonly year: boolean;
  readonly date: boolean;
  readonly sameDay: boolean;
}

const hiddenFor = (civil: Civil, today: Civil): Hidden => {
  const year = civil.year === today.year;
  const sameMonth = year && civil.month === today.month;
  const sameDay = sameMonth && civil.day === today.day;
  const recent =
    sameMonth && civil.day <= today.day && civil.day + DAYS_SHOWN_AS_WEEKDAY > today.day;
  return { year, date: recent, sameDay };
};

const showHuman = (
  timestamp: number,
  tz: number,
  nowSeconds: number,
  localOffsetMinutes: number,
): string => {
  const civil = civilAt(timestamp, tz);
  const hidden = hiddenFor(civil, civilAt(nowSeconds, localOffsetMinutes));
  if (hidden.sameDay) return showRelative(timestamp, nowSeconds);
  const parts = [
    hidden.year ? WEEKDAYS[civil.weekday] : undefined,
    hidden.date ? undefined : `${MONTHS[civil.month]} ${civil.day}`,
    hidden.year ? `${pad2(civil.hour)}:${pad2(civil.minute)}` : undefined,
    hidden.year ? undefined : String(civil.year),
    tz !== localOffsetMinutes && hidden.date ? zoneCompact(tz) : undefined,
  ];
  return parts.filter((part) => part !== undefined).join(' ');
};

const showCivil = (mode: DateMode, civil: Civil, tz: number): string => {
  switch (mode) {
    case 'rfc2822':
      return showRfc2822(civil, tz);
    case 'iso8601':
      return `${dayOf(civil)} ${clockOf(civil)} ${zoneCompact(tz)}`;
    case 'iso8601-strict':
      return `${dayOf(civil)}T${clockOf(civil)}${zoneStrict(tz)}`;
    case 'short':
      return dayOf(civil);
    default:
      return showNormal(civil, tz);
  }
};

export const showDate = (
  timestamp: number,
  tzOffsetMinutes: number,
  mode: DateMode,
  nowSeconds: number,
  localOffsetMinutes: number,
): string => {
  if (mode === 'relative') return showRelative(timestamp, nowSeconds);
  if (mode === 'human')
    return showHuman(timestamp, tzOffsetMinutes, nowSeconds, localOffsetMinutes);
  return showCivil(mode, civilAt(timestamp, tzOffsetMinutes), tzOffsetMinutes);
};
