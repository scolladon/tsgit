import { pathspecNoMatch } from '../../../domain/commands/error.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import {
  compilePathspec,
  type Pathspec,
  type PathspecEntry,
} from '../../../domain/pathspec/index.js';
import { validatePath } from './working-tree.js';

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
export const resolvePathspec = (patterns: ReadonlyArray<string>): ResolvedPathspec => {
  for (const raw of patterns) {
    const body = raw.startsWith('!') ? raw.slice(1) : raw;
    validatePath(body);
  }
  const matcher = compilePathspec(patterns);
  const literalMustMatch = matcher.filter(isPositiveLiteral).map((e) => bodyOf(e));
  const hasGlob = matcher.some(isPositiveGlob);
  return { matcher, literalMustMatch, hasGlob };
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
const bodyOf = (e: PathspecEntry): FilePath =>
  (e.pattern.startsWith('!') ? e.pattern.slice(1) : e.pattern) as FilePath;
