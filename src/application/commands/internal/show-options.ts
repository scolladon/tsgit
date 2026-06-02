/**
 * Pure resolver for `show`'s typed v2 options. Validates the option strings at
 * the command boundary (unknown `format`/`date` raise `INVALID_OPTION`) and
 * normalises them into a `ResolvedShowPlan` the command consumes — so the core
 * never sees an unparsed flag string. The accepted format/date/merge sets grow
 * as each flag-group lands; every value in scope is recognised at the final
 * shape.
 */
import { invalidOption } from '../../../domain/commands/error.js';
import {
  type DateMode,
  type PrettyFormat,
  parseDateMode,
  parsePretty,
} from '../../../domain/show/index.js';
import type { MergeDiffMode, ShowOptions } from '../show.js';

export interface ResolvedStat {
  readonly width: number;
  readonly nameWidth?: number;
  readonly count?: number;
}

export interface ResolvedShowPlan {
  readonly noPatch: boolean;
  /** Resolved pretty-format (built-in or `format:`/`tformat:`). */
  readonly format: PrettyFormat;
  /** Resolved `--date=` mode. */
  readonly dateMode: DateMode;
  readonly numstat: boolean;
  readonly stat?: ResolvedStat;
  readonly mergeDiff: MergeDiffMode;
  readonly contextLines?: number;
}

const resolveFormat = (format: string | undefined): PrettyFormat => {
  const parsed = parsePretty(format ?? 'medium');
  if (parsed === undefined) throw invalidOption('format', `unsupported format: ${format}`);
  return parsed;
};

const resolveDateMode = (date: string | undefined): DateMode => {
  const mode = parseDateMode(date ?? 'default');
  if (mode === undefined) throw invalidOption('date', `unsupported date mode: ${date}`);
  return mode;
};

export const parseShowOptions = (opts: ShowOptions): ResolvedShowPlan => {
  if (opts.numstat === true) throw invalidOption('numstat', 'unsupported');
  if (opts.stat !== undefined) throw invalidOption('stat', 'unsupported');
  if (opts.mergeDiff !== undefined) throw invalidOption('mergeDiff', 'unsupported');
  return {
    noPatch: opts.noPatch === true,
    format: resolveFormat(opts.format),
    dateMode: resolveDateMode(opts.date),
    numstat: false,
    mergeDiff: 'dense',
    ...(opts.contextLines !== undefined ? { contextLines: opts.contextLines } : {}),
  };
};
