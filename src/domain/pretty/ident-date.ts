import { type DateMode, showDate } from './date.js';

const INT_MAX = 2n ** 31n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;
const TIME_T_LIMIT = 2n ** 63n;

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

const asText = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

/** C's unsigned maximum-width parse: digits saturate at the unsigned maximum. */
const parseTimestamp = (digits: Uint8Array): bigint => {
  const value = BigInt(asText(digits));
  return value > UINT64_MAX ? UINT64_MAX : value;
};

/** C's long parse narrowed to an `int`: git drops a zone that does not fit to +0000. */
const parseZone = (zone: Uint8Array): number => {
  const value = BigInt(asText(zone));
  return value >= INT_MAX || value <= -INT_MAX - 1n ? 0 : Number(value);
};

/** An ident's `<timestamp> <+hhmm>` slices, rendered as git's `show_ident_date` does. */
export const showIdentDate = (
  date: Uint8Array,
  tz: Uint8Array,
  mode: DateMode,
  clock: DateClock,
): string => {
  const timestamp = parseTimestamp(date);
  const overflows = timestamp >= TIME_T_LIMIT;
  const zone = overflows ? 0 : parseZone(tz);
  return showDate(
    overflows ? 0n : timestamp,
    zone,
    mode,
    clock.nowSeconds,
    clock.localOffsetMinutes,
  );
};
