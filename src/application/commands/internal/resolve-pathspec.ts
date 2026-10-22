import {
  invalidOption,
  pathspecBeyondSymlink,
  pathspecOutsideRepo,
} from '../../../domain/commands/error.js';
import { TsgitError } from '../../../domain/error.js';
import { wellFormed } from '../../../domain/objects/encoding.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import {
  compilePathspec,
  type Pathspec,
  type PathspecEntry,
} from '../../../domain/pathspec/index.js';
import { globSpecialIndex } from '../../../domain/pathspec/wildcard.js';
import type { Context } from '../../../ports/context.js';
import { createLeadingPathScanner } from '../../primitives/internal/symlinked-leading-path.js';
import { validatePath } from './working-tree.js';

// Matching is linear, but a hostile pattern still chooses how much work it
// asks for. Cap raw pattern byte length AND the number of `**` tokens per
// pattern to bound that work. The byte cap measures UTF-8 encoded bytes
// (not UTF-16 code units) so non-ASCII patterns are bounded by their
// on-the-wire size.
const MAX_PATHSPEC_PATTERN_BYTES = 256;
const MAX_DOUBLE_STAR_PER_PATTERN = 4;
const PATTERN_ENCODER = new TextEncoder();

export interface ResolvedPathspec {
  /** The compiled matcher, ready for `matchesPathspec`. */
  readonly matcher: Pathspec;
  /** Non-negated literal patterns that the caller treats as must-match. */
  readonly literalMustMatch: ReadonlyArray<FilePath>;
  /** True iff any non-negated entry is a glob: routes add away from the literal-only fast path. */
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
// limited to `MAX_DOUBLE_STAR_PER_PATTERN` `**` tokens to bound the work a
// hostile pattern can request; both throw `INVALID_OPTION`.
export const resolvePathspec = (patterns: ReadonlyArray<string>): ResolvedPathspec => {
  const wellFormedPatterns = patterns.map(wellFormed);
  const collapsed = wellFormedPatterns.map(collapsePattern);
  for (const raw of wellFormedPatterns) enforcePatternBudget(raw);
  const matcher = compilePathspec(collapsed);
  const literalMustMatch = matcher.filter(isPositiveLiteral).map((e) => bodyOf(e));
  const hasGlob = matcher.some(isPositiveGlob);
  const symlinkScanTargets = matcher.flatMap(scanTargetsOf);
  return { matcher, literalMustMatch, hasGlob, symlinkScanTargets };
};

/** The empty prefix a pattern of nothing but `.` components collapses to: the whole tree. */
const WHOLE_TREE = '';
/** Whether `literal` is the whole-tree pathspec (`.` collapsed). */
export const namesWholeTree = (literal: FilePath): boolean => literal === WHOLE_TREE;

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
const BACKSLASH = '\\';
/** An ordinary byte the validator accepts anywhere and that cannot form a separator, `.` or a control byte. */
const BACKSLASH_STAND_IN = 'x';

/**
 * Validates a pathspec body with each backslash read as an ordinary byte —
 * wildmatch's escape is a matching concern, not a path separator here — so
 * every other rule (traversal, control bytes, `.git` aliases, leading `/`,
 * length) still applies. A refusal names the body as typed.
 */
const validatePathspecBody = (body: string): void => {
  if (!body.includes(BACKSLASH)) {
    validatePath(body);
    return;
  }
  try {
    validatePath(body.replaceAll(BACKSLASH, BACKSLASH_STAND_IN));
  } catch (err) {
    if (err instanceof TsgitError) throw pathspecOutsideRepo(body as FilePath);
    throw err;
  }
};

const collapsePattern = (raw: string): string => {
  const negation = raw.startsWith(NEGATION) ? NEGATION : '';
  const body = raw.slice(negation.length);
  if (body === '' || body.startsWith(SEPARATOR)) validatePathspecBody(body);
  const components = body.split(SEPARATOR);
  const kept = components.filter((component) => !isElided(component)).join(SEPARATOR);
  if (kept === WHOLE_TREE) return negation;
  validatePathspecBody(kept);
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

/**
 * What the leading-symlink scan walks for one entry. A body holding a
 * backslash is scanned by its no-wildcard prefix (the bytes before the first
 * glob-special byte, empty prefixes dropped); every other body is scanned whole.
 */
const scanTargetsOf = (entry: PathspecEntry): ReadonlyArray<FilePath> => {
  const body = bodyOf(entry);
  if (body === WHOLE_TREE) return [];
  if (!body.includes(BACKSLASH)) return [body];
  const prefix = body.slice(0, globSpecialIndex(body));
  return prefix === '' ? [] : [prefix as FilePath];
};

const isPositiveLiteral = (e: PathspecEntry): boolean => !e.negated && e.isLiteral;
const isPositiveGlob = (e: PathspecEntry): boolean => !e.negated && !e.isLiteral;
const bodyOf = (e: PathspecEntry): FilePath => e.body as FilePath;
