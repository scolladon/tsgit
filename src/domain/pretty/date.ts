import { timestampOutOfRange } from '../commands/error.js';

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

/** A calendar reading and the zone git prints beside it, which is not always the one asked for. */
interface Rendered {
  readonly civil: Civil;
  readonly zone: number;
}

const SECONDS_PER_DAY = 86400n;
const DAYS_FROM_YEAR_ZERO_TO_EPOCH = 719468n;
const DAYS_PER_ERA = 146097n;
const YEARS_PER_ERA = 400n;
const THURSDAY = 4n;
const DAYS_PER_WEEK_BIG = 7n;
const UINT64_BITS = 64;
const TIME_T_LIMIT = 1n << 63n;
const TM_YEAR_BASE = 1900;
const TM_YEAR_MAX = 2 ** 31 - 1;
const HOURS_MINUTES_DIVISOR = 100;

const int32 = (value: number): number => Math.imul(value, 1);

/** git's `tz` is the decimal reading of `+hhmm`, so `+0099` is 99 minutes and `-0100` is -60. */
const zoneMinutes = (zone: number): number => {
  const magnitude = Math.abs(zone);
  const minutes =
    Math.trunc(magnitude / HOURS_MINUTES_DIVISOR) * MINUTES_PER_HOUR +
    (magnitude % HOURS_MINUTES_DIVISOR);
  return zone < 0 ? -minutes : minutes;
};

const decimalZone = (offsetMinutes: number): number => {
  const magnitude = Math.abs(offsetMinutes);
  const hhmm =
    Math.floor(magnitude / MINUTES_PER_HOUR) * HOURS_MINUTES_DIVISOR +
    (magnitude % MINUTES_PER_HOUR);
  return offsetMinutes < 0 ? -hhmm : hhmm;
};

/**
 * git's `gm_time_t`. The shift is a C `int` product that wraps, and its bounds checks read that
 * product as the unsigned 32-bit value the compiler proves non-negative.
 */
const shiftedSeconds = (timestamp: bigint, zone: number): bigint => {
  const minutes = zoneMinutes(zone);
  const shift = Math.imul(minutes, SECONDS_PER_MINUTE);
  const reach = BigInt(Math.imul(-minutes, SECONDS_PER_MINUTE) >>> 0);
  if (minutes <= 0 && timestamp < reach) throw timestampOutOfRange('before-epoch', timestamp, zone);
  const shifted = BigInt.asUintN(UINT64_BITS, timestamp + BigInt(shift));
  if (shifted >= TIME_T_LIMIT) throw timestampOutOfRange('too-large', shifted, zone);
  return shifted;
};

const civilDate = (days: bigint): Pick<Civil, 'year' | 'month' | 'day'> => {
  const shifted = days + DAYS_FROM_YEAR_ZERO_TO_EPOCH;
  const era = shifted / DAYS_PER_ERA;
  const dayOfEra = shifted % DAYS_PER_ERA;
  const yearOfEra = (dayOfEra - dayOfEra / 1460n + dayOfEra / 36524n - dayOfEra / 146096n) / 365n;
  const dayOfYear = dayOfEra - (365n * yearOfEra + yearOfEra / 4n - yearOfEra / 100n);
  const shiftedMonth = (5n * dayOfYear + 2n) / 153n;
  const calendarMonth = shiftedMonth < 10n ? shiftedMonth + 3n : shiftedMonth - 9n;
  return {
    year: Number(yearOfEra + era * YEARS_PER_ERA + (calendarMonth <= 2n ? 1n : 0n)),
    month: Number(calendarMonth) - 1,
    day: Number(dayOfYear - (153n * shiftedMonth + 2n) / 5n + 1n),
  };
};

const civilOfSeconds = (seconds: bigint): Civil => {
  const days = seconds / SECONDS_PER_DAY;
  const secondOfDay = Number(seconds % SECONDS_PER_DAY);
  return {
    ...civilDate(days),
    weekday: Number((days + THURSDAY) % DAYS_PER_WEEK_BIG),
    hour: Math.floor(secondOfDay / (MINUTES_PER_HOUR * SECONDS_PER_MINUTE)),
    minute: Math.floor(secondOfDay / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR,
    second: secondOfDay % SECONDS_PER_MINUTE,
  };
};

const EPOCH: Rendered = { civil: civilOfSeconds(0n), zone: 0 };

/** The C library refuses a year whose `tm_year` overflows an int; git then prints the epoch in UTC. */
const renderedAt = (timestamp: bigint, zone: number): Rendered => {
  const civil = civilOfSeconds(shiftedSeconds(timestamp, zone));
  if (civil.year - TM_YEAR_BASE > TM_YEAR_MAX) return EPOCH;
  return { civil: { ...civil, year: int32(civil.year) }, zone };
};

const pad2 = (value: number): string => String(value).padStart(2, '0');

const signOf = (zone: number): string => (zone < 0 ? '-' : '+');

/** git's `%+05d`. */
const zoneCompact = (zone: number): string =>
  `${signOf(zone)}${String(Math.abs(zone)).padStart(4, '0')}`;

const zoneStrict = (zone: number): string => {
  if (zone === 0) return 'Z';
  const magnitude = Math.abs(zone);
  return `${signOf(zone)}${pad2(Math.trunc(magnitude / HOURS_MINUTES_DIVISOR))}:${pad2(magnitude % HOURS_MINUTES_DIVISOR)}`;
};

const dayOf = (civil: Civil): string =>
  `${String(civil.year).padStart(4, '0')}-${pad2(civil.month + 1)}-${pad2(civil.day)}`;

const clockOf = (civil: Civil): string =>
  `${pad2(civil.hour)}:${pad2(civil.minute)}:${pad2(civil.second)}`;

/** git hides the zone of a plain date when it equals `human_tz`, which is -1 outside human mode. */
const NO_HUMAN_ZONE = -1;

const showNormal = ({ civil, zone }: Rendered): string => {
  const head = `${WEEKDAYS[civil.weekday]} ${MONTHS[civil.month]} ${civil.day} ${clockOf(civil)} ${civil.year}`;
  return zone === NO_HUMAN_ZONE ? head : `${head} ${zoneCompact(zone)}`;
};

const showRfc2822 = ({ civil, zone }: Rendered): string =>
  `${WEEKDAYS[civil.weekday]}, ${civil.day} ${MONTHS[civil.month]} ${civil.year} ${clockOf(civil)} ${zoneCompact(zone)}`;

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

const showRelative = (timestamp: bigint, nowSeconds: number): string => {
  if (BigInt(nowSeconds) < timestamp) return 'in the future';
  const seconds = nowSeconds - Number(timestamp);
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
  timestamp: bigint,
  zone: number,
  nowSeconds: number,
  localOffsetMinutes: number,
): string => {
  const { civil, zone: shownZone } = renderedAt(timestamp, zone);
  const today = civilOfSeconds(BigInt(nowSeconds + localOffsetMinutes * SECONDS_PER_MINUTE));
  const hidden = hiddenFor(civil, today);
  if (hidden.sameDay) return showRelative(timestamp, nowSeconds);
  const parts = [
    hidden.year ? WEEKDAYS[civil.weekday] : undefined,
    hidden.date ? undefined : `${MONTHS[civil.month]} ${civil.day}`,
    hidden.year ? `${pad2(civil.hour)}:${pad2(civil.minute)}` : undefined,
    hidden.year ? undefined : String(civil.year),
    shownZone !== decimalZone(localOffsetMinutes) && hidden.date
      ? zoneCompact(shownZone)
      : undefined,
  ];
  return parts.filter((part) => part !== undefined).join(' ');
};

const showCivil = (mode: DateMode, rendered: Rendered): string => {
  const { civil, zone } = rendered;
  switch (mode) {
    case 'rfc2822':
      return showRfc2822(rendered);
    case 'iso8601':
      return `${dayOf(civil)} ${clockOf(civil)} ${zoneCompact(zone)}`;
    case 'iso8601-strict':
      return `${dayOf(civil)}T${clockOf(civil)}${zoneStrict(zone)}`;
    case 'short':
      return dayOf(civil);
    default:
      return showNormal(rendered);
  }
};

/** `zone` is git's decimal `+hhmm` reading, not minutes; `timestamp` is seconds since the epoch. */
export const showDate = (
  timestamp: bigint,
  zone: number,
  mode: DateMode,
  nowSeconds: number,
  localOffsetMinutes: number,
): string => {
  if (mode === 'relative') return showRelative(timestamp, nowSeconds);
  if (mode === 'human') return showHuman(timestamp, zone, nowSeconds, localOffsetMinutes);
  return showCivil(mode, renderedAt(timestamp, zone));
};
