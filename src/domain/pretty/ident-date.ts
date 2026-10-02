import { type DateMode, showDate } from './date.js';

const MINUTES_PER_HOUR = 60;
const HOURS_MINUTES_DIVISOR = 100;
const DECIMAL = 10;

export interface DateClock {
  readonly nowSeconds: number;
  readonly localOffsetMinutes: number;
}

export const DATE_MODE_BY_PART: ReadonlyMap<string, DateMode> = new Map([
  ['d', 'normal'],
  ['D', 'rfc2822'],
  ['r', 'relative'],
  ['i', 'iso8601'],
  ['I', 'iso8601-strict'],
  ['s', 'short'],
  ['h', 'human'],
]);

const asNumber = (digits: Uint8Array): number =>
  Number.parseInt(new TextDecoder('latin1').decode(digits), DECIMAL);

const tzMinutes = (tz: Uint8Array): number => {
  const sign = tz[0] === 0x2d ? -1 : 1;
  const hhmm = asNumber(tz.subarray(1));
  const hours = Math.floor(hhmm / HOURS_MINUTES_DIVISOR);
  return sign * (hours * MINUTES_PER_HOUR + (hhmm % HOURS_MINUTES_DIVISOR));
};

/** An ident's `<timestamp> <+hhmm>` slices, rendered as git's `show_ident_date` does. */
export const showIdentDate = (
  date: Uint8Array,
  tz: Uint8Array,
  mode: DateMode,
  clock: DateClock,
): string =>
  showDate(asNumber(date), tzMinutes(tz), mode, clock.nowSeconds, clock.localOffsetMinutes);
