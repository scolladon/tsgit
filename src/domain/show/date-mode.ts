/**
 * `--date=<mode>` parsing and formatting. Absolute modes are pure functions of
 * `(timestamp, offset)` and interop-pinned; `relative`/`human` additionally
 * read `now` and are covered structurally (ADR-247). `parseDateMode` returns
 * `undefined` for an unknown spec so the command boundary can raise the typed
 * `INVALID_OPTION`.
 */

import { formatHumanDate } from './date-human.js';
import {
  localClockParts,
  MONTHS,
  offsetSeconds,
  pad2,
  WEEKDAYS,
  wallClockParts,
} from './date-parts.js';
import { formatRelativeDate } from './date-relative.js';
import { formatGitDate } from './git-date.js';
import { strftime } from './strftime.js';

export type DateMode =
  | { readonly kind: 'default' }
  | { readonly kind: 'iso' }
  | { readonly kind: 'iso-strict' }
  | { readonly kind: 'rfc' }
  | { readonly kind: 'short' }
  | { readonly kind: 'raw' }
  | { readonly kind: 'unix' }
  | { readonly kind: 'local' }
  | { readonly kind: 'relative' }
  | { readonly kind: 'human' }
  | { readonly kind: 'strftime'; readonly format: string };

const NAMED: Readonly<Record<string, DateMode>> = {
  default: { kind: 'default' },
  normal: { kind: 'default' },
  iso: { kind: 'iso' },
  iso8601: { kind: 'iso' },
  'iso-strict': { kind: 'iso-strict' },
  'iso8601-strict': { kind: 'iso-strict' },
  rfc: { kind: 'rfc' },
  rfc2822: { kind: 'rfc' },
  short: { kind: 'short' },
  raw: { kind: 'raw' },
  unix: { kind: 'unix' },
  local: { kind: 'local' },
  relative: { kind: 'relative' },
  human: { kind: 'human' },
};

const FORMAT_PREFIX = 'format:';

export const parseDateMode = (spec: string): DateMode | undefined => {
  if (spec.startsWith(FORMAT_PREFIX))
    return { kind: 'strftime', format: spec.slice(FORMAT_PREFIX.length) };
  return NAMED[spec];
};

const time = (h: number, m: number, s: number): string => `${pad2(h)}:${pad2(m)}:${pad2(s)}`;

const formatIso = (timestamp: number, tz: string): string => {
  const p = wallClockParts(timestamp, tz);
  return `${p.year}-${pad2(p.monthIndex + 1)}-${pad2(p.day)} ${time(p.hours, p.minutes, p.seconds)} ${tz}`;
};

const isoStrictOffset = (tz: string): string =>
  offsetSeconds(tz) === 0 ? 'Z' : `${tz.slice(0, 3)}:${tz.slice(3, 5)}`;

const formatIsoStrict = (timestamp: number, tz: string): string => {
  const p = wallClockParts(timestamp, tz);
  return `${p.year}-${pad2(p.monthIndex + 1)}-${pad2(p.day)}T${time(p.hours, p.minutes, p.seconds)}${isoStrictOffset(tz)}`;
};

const formatShort = (timestamp: number, tz: string): string => {
  const p = wallClockParts(timestamp, tz);
  return `${p.year}-${pad2(p.monthIndex + 1)}-${pad2(p.day)}`;
};

export const formatRfc2822 = (timestamp: number, tz: string): string => {
  const p = wallClockParts(timestamp, tz);
  return `${WEEKDAYS[p.weekdayIndex]}, ${p.day} ${MONTHS[p.monthIndex]} ${p.year} ${time(p.hours, p.minutes, p.seconds)} ${tz}`;
};

const formatLocal = (timestamp: number): string => {
  const p = localClockParts(timestamp);
  return `${WEEKDAYS[p.weekdayIndex]} ${MONTHS[p.monthIndex]} ${p.day} ${time(p.hours, p.minutes, p.seconds)} ${p.year}`;
};

export const formatDate = (mode: DateMode, timestamp: number, tz: string, now: number): string => {
  switch (mode.kind) {
    case 'default':
      return formatGitDate(timestamp, tz);
    case 'iso':
      return formatIso(timestamp, tz);
    case 'iso-strict':
      return formatIsoStrict(timestamp, tz);
    case 'rfc':
      return formatRfc2822(timestamp, tz);
    case 'short':
      return formatShort(timestamp, tz);
    case 'raw':
      return `${timestamp} ${tz}`;
    case 'unix':
      return String(timestamp);
    case 'local':
      return formatLocal(timestamp);
    case 'relative':
      return formatRelativeDate(timestamp, now);
    case 'human':
      return formatHumanDate(timestamp, tz, now);
    case 'strftime':
      return strftime(mode.format, timestamp, tz);
  }
};
