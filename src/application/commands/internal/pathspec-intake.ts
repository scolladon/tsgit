import { pathspecOutsideRepo } from '../../../domain/commands/error.js';
import { wellFormed } from '../../../domain/objects/encoding.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import type { Pathspec, PathspecEntry } from '../../../domain/pathspec/index.js';
import { type PathspecVerdict, pathspecVerdict } from '../../../domain/pathspec/match-pathspec.js';
import { MATCH_LEVEL, type MatchLevel } from '../../../domain/pathspec/wildcard.js';
import { type ResolvedPathspec, resolvePathspec } from './resolve-pathspec.js';

const BACKSLASH = '\\';

/** What the intake reads of the host: a `Context` satisfies it. */
export interface PathspecHost {
  readonly windowsPathSyntax?: boolean;
}

export interface PositivePathspec {
  readonly entry: PathspecEntry;
  /** The well-formed raw pattern as typed. */
  readonly spelling: string;
  /** False for a body holding a backslash: it is matched, never looked up on disk. */
  readonly probesDisk: boolean;
}

export interface CommandPathspec extends ResolvedPathspec {
  /** Non-negated patterns in argument order, duplicates kept. */
  readonly positives: ReadonlyArray<PositivePathspec>;
}

export const positiveOf = (entry: PathspecEntry, spelling: string): PositivePathspec => ({
  entry,
  spelling,
  probesDisk: !entry.body.includes(BACKSLASH),
});

const NEGATION = '!';

const bodyOf = (pattern: string): string =>
  pattern.startsWith(NEGATION) ? pattern.slice(NEGATION.length) : pattern;

// git for Windows reads `\` as a separator; tsgit keeps refusing it there.
const refuseBackslash = (paths: ReadonlyArray<string>): void => {
  const offending = paths.map(bodyOf).find((body) => body.includes(BACKSLASH));
  if (offending !== undefined) throw pathspecOutsideRepo(offending as FilePath);
};

export const resolveCommandPathspec = (
  host: PathspecHost,
  paths: ReadonlyArray<string>,
): CommandPathspec => {
  if (host.windowsPathSyntax === true) refuseBackslash(paths);
  const resolved = resolvePathspec(paths);
  const positives = resolved.matcher.flatMap((entry, index) =>
    entry.negated ? [] : [positiveOf(entry, wellFormed(paths[index] as string))],
  );
  return { ...resolved, positives };
};

export const unmatchedPositives = (
  positives: ReadonlyArray<PositivePathspec>,
  isSeen: (positive: PositivePathspec) => boolean,
): ReadonlyArray<PositivePathspec> => positives.filter((positive) => !isSeen(positive));

/** One matcher pass's bookkeeping: which positives the observed paths reached, and how far. */
export interface PositiveTracker {
  /** Judges one path: records every positive's level for it and returns the spec's verdict. */
  observe(path: FilePath): PathspecVerdict;
  /** Whether some observed path reached the positive. */
  seen(positive: PositivePathspec): boolean;
  /** The highest level each positive reached, in positives order. */
  highest(): ReadonlyArray<MatchLevel>;
}

/**
 * Positives are built from the matcher's own entries (`resolveCommandPathspec`),
 * so each one's entry is found in the matcher by identity and its verdict level
 * is read at that index.
 */
export const trackPositives = (
  matcher: Pathspec,
  positives: ReadonlyArray<PositivePathspec>,
): PositiveTracker => {
  const at = positives.map((positive) => matcher.indexOf(positive.entry));
  const highest: MatchLevel[] = positives.map(() => MATCH_LEVEL.NONE);
  return {
    observe(path) {
      const verdict = pathspecVerdict(matcher, path);
      at.forEach((index, i) => {
        const level = verdict.levels[index] ?? MATCH_LEVEL.NONE;
        if (level > (highest[i] as MatchLevel)) highest[i] = level;
      });
      return verdict;
    },
    seen(positive) {
      const slot = positives.indexOf(positive);
      return slot !== -1 && highest[slot] !== MATCH_LEVEL.NONE;
    },
    highest: () => highest,
  };
};
