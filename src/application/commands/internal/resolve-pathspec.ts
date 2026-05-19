import { invalidOption, pathspecNoMatch } from '../../../domain/commands/error.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import {
  compilePathspec,
  type Pathspec,
  type PathspecEntry,
} from '../../../domain/pathspec/index.js';
import { validatePath } from './working-tree.js';

// Pathspec patterns are compiled to RegExp. Globs containing many `**`
// tokens or thousands of `*` characters yield regexes whose worst-case
// matching cost grows quadratically. Cap raw pattern length AND the
// number of `**` tokens per pattern to keep compilation + matching
// linear in the path length.
const MAX_PATHSPEC_PATTERN_BYTES = 256;
const MAX_DOUBLE_STAR_PER_PATTERN = 4;

export interface ResolvedPathspec {
  /** The compiled matcher, ready for `matchesPathspec`. */
  readonly matcher: Pathspec;
  /** Non-negated literal patterns that the caller treats as must-match. */
  readonly literalMustMatch: ReadonlyArray<FilePath>;
  /** True iff any non-negated entry is a glob (relaxes whole-call no-match). */
  readonly hasGlob: boolean;
}

// Validate every input pattern (after stripping a leading `!`) and
// compile the pathspec. The validator rejects `..`, leading `/`, NUL
// bytes, and other unsafe segments — so a pattern like `!../escape`
// is rejected via the body even though it is "negated".
//
// Patterns are also length-capped at `MAX_PATHSPEC_PATTERN_BYTES` and
// limited to `MAX_DOUBLE_STAR_PER_PATTERN` `**` tokens to bound the
// cost of the compiled regex; both throw `INVALID_OPTION`.
export const resolvePathspec = (patterns: ReadonlyArray<string>): ResolvedPathspec => {
  for (const raw of patterns) {
    const body = raw.startsWith('!') ? raw.slice(1) : raw;
    validatePath(body);
    enforcePatternBudget(raw);
  }
  const matcher = compilePathspec(patterns);
  const literalMustMatch = matcher.filter(isPositiveLiteral).map((e) => bodyOf(e));
  const hasGlob = matcher.some(isPositiveGlob);
  return { matcher, literalMustMatch, hasGlob };
};

const enforcePatternBudget = (pattern: string): void => {
  if (pattern.length > MAX_PATHSPEC_PATTERN_BYTES) {
    throw invalidOption('paths', `pattern exceeds max length ${MAX_PATHSPEC_PATTERN_BYTES} bytes`);
  }
  if (countDoubleStars(pattern) > MAX_DOUBLE_STAR_PER_PATTERN) {
    throw invalidOption(
      'paths',
      `pattern exceeds max **-token count ${MAX_DOUBLE_STAR_PER_PATTERN}`,
    );
  }
};

const countDoubleStars = (pattern: string): number => {
  let count = 0;
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      count += 1;
      i += 2;
      continue;
    }
    i += 1;
  }
  return count;
};

// Throw `PATHSPEC_NO_MATCH` for any literal that did not match at least
// one path. A literal matches when an entry in `matched` equals it OR
// starts with `<literal>/` (literals act as directory prefixes — same
// semantics as `git add src`).
export const enforceLiteralMustMatch = (
  literals: ReadonlyArray<FilePath>,
  matched: ReadonlyArray<FilePath>,
): void => {
  if (literals.length === 0) return;
  const matchedSet = new Set(matched);
  for (const lit of literals) {
    if (matchedSet.has(lit)) continue;
    if (matched.some((m) => m.startsWith(`${lit}/`))) continue;
    throw pathspecNoMatch(lit);
  }
};

const isPositiveLiteral = (e: PathspecEntry): boolean => !e.negated && e.isLiteral;
const isPositiveGlob = (e: PathspecEntry): boolean => !e.negated && !e.isLiteral;
const bodyOf = (e: PathspecEntry): FilePath => e.body as FilePath;
