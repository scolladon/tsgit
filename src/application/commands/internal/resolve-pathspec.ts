import {
  invalidOption,
  pathspecBeyondSymlink,
  pathspecNoMatch,
} from '../../../domain/commands/error.js';
import { wellFormed } from '../../../domain/objects/encoding.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import {
  compilePathspec,
  type Pathspec,
  type PathspecEntry,
} from '../../../domain/pathspec/index.js';
import type { Context } from '../../../ports/context.js';
import { createLeadingPathScanner } from '../../primitives/internal/symlinked-leading-path.js';
import { validatePath } from './working-tree.js';

// Pathspec patterns are compiled to RegExp. Globs containing many `**`
// tokens or thousands of `*` characters yield regexes whose worst-case
// matching cost grows quadratically. Cap raw pattern byte length AND
// the number of `**` tokens per pattern to keep compilation + matching
// linear in the path length. The byte cap measures UTF-8 encoded
// bytes (not UTF-16 code units) so non-ASCII patterns are bounded by
// their on-the-wire size.
const MAX_PATHSPEC_PATTERN_BYTES = 256;
const MAX_DOUBLE_STAR_PER_PATTERN = 4;
const PATTERN_ENCODER = new TextEncoder();

export interface ResolvedPathspec {
  /** The compiled matcher, ready for `matchesPathspec`. */
  readonly matcher: Pathspec;
  /** Non-negated literal patterns that the caller treats as must-match. */
  readonly literalMustMatch: ReadonlyArray<FilePath>;
  /** How each must-match literal was first spelled by the caller — what git names on no match. */
  readonly literalSpellings: ReadonlyMap<FilePath, string>;
  /** True iff any non-negated entry is a glob (relaxes whole-call no-match). */
  readonly hasGlob: boolean;
  /**
   * Every pattern body — literal or glob, negated or not — for
   * {@link assertNoSymlinkedLeadingPath} to scan. A glob's own magic segment
   * (e.g. the `*.ts` in `link/*.ts`) never resolves as a literal path, so the
   * scan naturally stops there without a dedicated magic/literal splitter.
   * Negation is a MATCH-time filter, not an exemption from this scan — git
   * refuses `git add . ':!link/x'` with "pathspec ':!link/x' is beyond a
   * symbolic link" exactly as it would the positive form.
   */
  readonly symlinkScanTargets: ReadonlyArray<FilePath>;
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
  const wellFormedPatterns = patterns.map(wellFormed);
  const collapsed = wellFormedPatterns.map(collapsePattern);
  for (const raw of wellFormedPatterns) enforcePatternBudget(raw);
  const matcher = compilePathspec(collapsed);
  const literalMustMatch = matcher.filter(isPositiveLiteral).map((e) => bodyOf(e));
  const literalSpellings = spellLiterals(matcher, wellFormedPatterns);
  const hasGlob = matcher.some(isPositiveGlob);
  const symlinkScanTargets = matcher.map((e) => bodyOf(e)).filter((body) => body !== WHOLE_TREE);
  return { matcher, literalMustMatch, literalSpellings, hasGlob, symlinkScanTargets };
};

/** Each positive literal's first raw spelling, `matcher` and `patterns` being index-aligned. */
const spellLiterals = (
  matcher: Pathspec,
  patterns: ReadonlyArray<string>,
): ReadonlyMap<FilePath, string> => {
  const spellings = new Map<FilePath, string>();
  matcher.forEach((entry, index) => {
    const literal = bodyOf(entry);
    if (!isPositiveLiteral(entry) || spellings.has(literal)) return;
    spellings.set(literal, patterns[index] as string);
  });
  return spellings;
};

/** The empty prefix a pattern of nothing but `.` components collapses to: the whole tree. */
const WHOLE_TREE = '';
/** Whether `literal` is the whole-tree pathspec (`.` collapsed). */
export const namesWholeTree = (literal: FilePath): boolean => literal === WHOLE_TREE;

/** How git spells the whole-tree pathspec back. */
const WHOLE_TREE_SPELLING = '.';
const NEGATION = '!';
const CURRENT_DIRECTORY = '.';

const SEPARATOR = '/';

/** Whether `literal` names a directory only — git's trailing-slash pathspec. */
export const namesDirectoryOnly = (literal: FilePath): boolean => literal.endsWith(SEPARATOR);

/** A component `normalize_path_copy` drops: an empty one (a doubled `/`) or `.`. */
const isElided = (component: string): boolean =>
  component === '' || component === CURRENT_DIRECTORY;

/**
 * git's `prefix_path` normalisation (`./a` → `a`, `d//b` → `d/b`, `.` → the
 * whole tree), which keeps a trailing `/` — `d/`, `d/.` and `d/./` all name
 * the directory `d` only — then the body's validation. A pattern that was
 * empty before the collapse, or absolute, is refused by the validator.
 */
const collapsePattern = (raw: string): string => {
  const negation = raw.startsWith(NEGATION) ? NEGATION : '';
  const body = raw.slice(negation.length);
  if (body === '' || body.startsWith(SEPARATOR)) validatePath(body);
  const components = body.split(SEPARATOR);
  const kept = components.filter((component) => !isElided(component)).join(SEPARATOR);
  if (kept === WHOLE_TREE) return negation;
  validatePath(kept);
  const directoryOnly = isElided(components[components.length - 1] as string);
  return `${negation}${kept}${directoryOnly ? SEPARATOR : ''}`;
};

const enforcePatternBudget = (pattern: string): void => {
  if (PATTERN_ENCODER.encode(pattern).byteLength > MAX_PATHSPEC_PATTERN_BYTES) {
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
  // Stryker disable next-line EqualityOperator: equivalent — when `i === pattern.length`, `pattern[i]` is `undefined`, never `'*'`, so the extra iteration counts nothing and exits.
  while (i < pattern.length) {
    // Stryker disable next-line ArithmeticOperator: equivalent — when `pattern[i]` is `'*'`, the scanner stepped over `pattern[i-1]` by 1; a preceding `'*'` would already have started a counted pair, so the lookbehind never adds a distinct count (verified exhaustively).
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
  spellings: ReadonlyMap<FilePath, string> = NO_SPELLINGS,
): void => {
  // Stryker disable next-line ConditionalExpression: equivalent — the early return only skips an empty `for` loop; with zero literals the loop body never runs, so the observable result is identical.
  if (literals.length === 0) return;
  const matchedSet = new Set(matched);
  for (const lit of literals) {
    if (namesWholeTree(lit)) {
      if (matched.length > 0) continue;
      throw pathspecNoMatch(spellings.get(lit) ?? WHOLE_TREE_SPELLING);
    }
    if (matchedSet.has(lit)) continue;
    if (matched.some((m) => m.startsWith(descendantPrefix(lit)))) continue;
    throw pathspecNoMatch(spellings.get(lit) ?? lit);
  }
};

const NO_SPELLINGS: ReadonlyMap<FilePath, string> = new Map();

/** What a path beneath `literal` starts with: a directory literal already ends in `/`. */
const descendantPrefix = (literal: FilePath): string =>
  namesDirectoryOnly(literal) ? literal : `${literal}${SEPARATOR}`;

// Refuse a pathspec body — literal or glob — that names a file beyond a
// symbolic link — git's `has_symlinked_leading_path` refusal, shape-based
// (fires for an intra-repo link target too). Git checks path components
// lexically: a glob's leading directory segment is scanned exactly like a
// literal's, and only its magic segment (which cannot itself resolve as a
// literal path) stops the scan short. Builds one scanner per call so its
// per-directory memo is shared across the whole pathspec set.
export const assertNoSymlinkedLeadingPath = async (
  ctx: Context,
  targets: ReadonlyArray<FilePath>,
): Promise<void> => {
  const scanner = createLeadingPathScanner(ctx);
  for (const target of targets) {
    if (await scanner.hasSymlinkedLeadingPath(target)) {
      throw pathspecBeyondSymlink(target);
    }
  }
};

const isPositiveLiteral = (e: PathspecEntry): boolean => !e.negated && e.isLiteral;
const isPositiveGlob = (e: PathspecEntry): boolean => !e.negated && !e.isLiteral;
const bodyOf = (e: PathspecEntry): FilePath => e.body as FilePath;
