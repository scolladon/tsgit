import { FILE_MODE, type FileMode } from '../objects/file-mode.js';

export type VerifyPathRejection =
  | 'absolute-path'
  | 'empty-segment'
  | 'dot-segment'
  | 'dotdot-segment'
  | 'dotgit-alias'
  | 'dotgit-ntfs-alias'
  | 'dotgit-ntfs-stream'
  | 'dotgit-hfs-alias'
  | 'gitmodules-not-regular';

const DOTGIT = '.git';
const NTFS_SHORT_NAME = 'git~1';
const GITMODULES = '.gitmodules';
const TRAILING_DOT_SPACE = /[. ]+$/;

const codepointRange = (start: number, end: number): readonly number[] =>
  Array.from({ length: end - start + 1 }, (_, offset) => start + offset);

/**
 * HFS+ silently ignores these codepoints when comparing filenames, so a name
 * like `.g<ZWNJ>it` resolves to the same file as `.git` on an HFS+ volume —
 * git's protectHFS guard strips them before re-testing for the `.git` alias.
 * Closed literal list (never a range guess): U+2060 is deliberately absent.
 */
const IGNORABLE_CODEPOINTS: ReadonlySet<number> = new Set([
  ...codepointRange(0x200c, 0x200f),
  ...codepointRange(0x202a, 0x202e),
  ...codepointRange(0x206a, 0x206f),
  0xfeff,
]);

const normalizeAliasCandidate = (part: string): string =>
  part.replace(TRAILING_DOT_SPACE, '').toLowerCase();

const stripIgnorableCodepoints = (part: string): string =>
  part
    .split('')
    .filter((char) => !IGNORABLE_CODEPOINTS.has(char.charCodeAt(0)))
    .join('');

// Cheap pre-scan so the allocating split/filter/join strip only runs for the
// rare component that actually carries an ignorable codepoint.
const hasIgnorableCodepoint = (part: string): boolean => {
  for (let i = 0; i < part.length; i += 1) {
    if (IGNORABLE_CODEPOINTS.has(part.charCodeAt(i))) return true;
  }
  return false;
};

/**
 * git's `is_ntfs_dot_generic` treats `:` as a component terminator: an NTFS
 * alternate-data-stream suffix on EITHER the full name or a short-name alias
 * still targets the same file, so it must match too. Splitting once here lets
 * every alias comparison run against the pre-stream candidate while the
 * caller still learns whether a stream suffix was present, to choose between
 * the plain and the `-ntfs-stream` rejection reason.
 */
const splitAtStream = (part: string): { candidate: string; hasStream: boolean } => {
  const colonIndex = part.indexOf(':');
  return colonIndex === -1
    ? { candidate: part, hasStream: false }
    : { candidate: part.slice(0, colonIndex), hasStream: true };
};

const matchAliasPart = (part: string): VerifyPathRejection | undefined => {
  const { candidate, hasStream } = splitAtStream(part);
  const normalized = normalizeAliasCandidate(candidate);
  if (normalized === DOTGIT) return hasStream ? 'dotgit-ntfs-stream' : 'dotgit-alias';
  if (normalized === NTFS_SHORT_NAME) {
    return hasStream ? 'dotgit-ntfs-stream' : 'dotgit-ntfs-alias';
  }
  if (!hasIgnorableCodepoint(part)) return undefined;
  const hfsNormalized = normalizeAliasCandidate(stripIgnorableCodepoints(part));
  return hfsNormalized === DOTGIT ? 'dotgit-hfs-alias' : undefined;
};

// The `\` split exists only to feed this scan (`.git\config` reads as two
// parts, `.git` and `config`) — a bare backslash is never a rejection. Most
// components carry no backslash at all, so skip the allocating split for them.
const matchAliasComponent = (component: string): VerifyPathRejection | undefined => {
  if (component.indexOf('\\') === -1) return matchAliasPart(component);
  for (const part of component.split('\\')) {
    const reason = matchAliasPart(part);
    if (reason !== undefined) return reason;
  }
  return undefined;
};

/** True if `component` is `.git` or one of its NTFS/HFS-obscured aliases. */
export const isDotGitAlias = (component: string): boolean =>
  matchAliasComponent(component) !== undefined;

/**
 * True if `name` is `.git`, folded only by case — the narrow match git's own
 * *directory walk* (`read_directory`) applies when deciding whether an
 * on-disk entry is its own control directory or an embedded repository's.
 * Unlike {@link isDotGitAlias}, this does NOT widen to the NTFS/HFS
 * index-write alias matrix: `git~1`, a `.git:`-stream name, an HFS
 * ignorable-codepoint alias, and a trailing-dot/space variant all fail this
 * test and are ordinary walked entries. Pinned empirically against
 * `git status --porcelain -uall` (git 2.55.0, darwin, `core.ignorecase=true`
 * — the platform default): `.GIT` is invisible to the walk, while a nested
 * `git~1`, `.git:stream`, `.g<ZWNJ>it`, `.git.` and `.git ` directory are all
 * reported `??`.
 *
 * The fold here is UNCONDITIONAL — this deliberately does not gate on the
 * repository's own `core.ignorecase` the way real git's directory walk does.
 * On a Linux repo with `core.ignorecase=false` (the platform default there),
 * real git's walk is case-sensitive and would list a `.GIT` directory as an
 * ordinary untracked entry; tsgit always folds and skips it regardless. This
 * is a known, deliberate simplification — threading `core.ignorecase`
 * through the walk boundary is out of scope here.
 */
export const isDotGitWalkEntry = (name: string): boolean => name.toLowerCase() === DOTGIT;

const matchShape = (component: string): VerifyPathRejection | undefined => {
  if (component === '') return 'empty-segment';
  if (component === '.') return 'dot-segment';
  if (component === '..') return 'dotdot-segment';
  return undefined;
};

const findComponentRejection = (components: readonly string[]): VerifyPathRejection | undefined => {
  for (const component of components) {
    const reason = matchShape(component) ?? matchAliasComponent(component);
    if (reason !== undefined) return reason;
  }
  return undefined;
};

// NTFS short-name forms for `.gitmodules`: Windows' 8.3 generator emits
// `GITMOD~1`..`GITMOD~4` for the truncated base name, then falls back to a
// hashed 6-char prefix (`GI7EBA~<digit>`) once those four are taken — pinned
// against git 2.55 (`update-index --add --cacheinfo 120000,<blob>,<name>`):
// `gitmod~1`..`gitmod~4` are refused, `gitmod~0` and `gitmod~5`+ are not;
// `gi7eba~1`..`gi7eba~9` are refused, while any OTHER 6-char prefix, digit
// `0`, or 2+ digits (`gi7eba~10`) is not — the hashed prefix is a hardcoded
// literal, not a computed check, and Windows only ever emits a single
// trailing digit for the hashed form.
const GITMOD_NTFS_SHORT_NAME = /^gitmod~[1-4]$/;
const GITMOD_NTFS_HASHED_SHORT_NAME = /^gi7eba~[1-9]$/;

/**
 * True if `component` is `.gitmodules` or one of its NTFS (`gitmod~1`..
 * `gitmod~4` truncated short name, `gi7eba~1`..`gi7eba~9` hashed short name —
 * either with a `:`-stream suffix) / HFS+ (ignorable-codepoint) aliases — the
 * same normalisation {@link matchAliasPart} runs for `.git`, re-targeted at
 * `.gitmodules`. Unlike {@link matchAliasComponent}, this skips the
 * backslash-split: a component reaching `verifyPath` has already passed
 * `validateIndexPath`'s unconditional backslash rejection, so a
 * `.gitmodules`-alias component can never itself carry an embedded `\`.
 */
const matchGitmodulesAliasPart = (component: string): boolean => {
  const { candidate } = splitAtStream(component);
  const normalized = normalizeAliasCandidate(candidate);
  if (normalized === GITMODULES) return true;
  if (GITMOD_NTFS_SHORT_NAME.test(normalized)) return true;
  if (GITMOD_NTFS_HASHED_SHORT_NAME.test(normalized)) return true;
  // Stryker disable next-line ConditionalExpression: equivalent — when hasIgnorableCodepoint(component) is false, stripIgnorableCodepoints(component) removes nothing, so the line below reduces to normalizeAliasCandidate(component) === GITMODULES; component either equals `candidate` (already ruled out on line 159) or carries a `:` stream suffix that normalizeAliasCandidate never strips, so that comparison can never be true — skipping the early return produces the same `false` either way.
  if (!hasIgnorableCodepoint(component)) return false;
  return normalizeAliasCandidate(stripIgnorableCodepoints(component)) === GITMODULES;
};

// CVE-2018-11235 hardening: an entry whose mode is a symlink must not carry
// a `.gitmodules` path component (or one of its NTFS/HFS-obscured aliases)
// ANYWHERE — not only as the leaf. Verified against git (`update-index --add
// --cacheinfo 120000,<blob>,.gitmodules/foo` → `error: Invalid path`): the
// check runs once per path component, gated on the entry's own mode, exactly
// like the `.git`-alias scan above — a `.gitmodules` directory holding an
// unrelated symlinked leaf is refused exactly as a symlinked `.gitmodules`
// leaf itself is.
const hasGitmodulesSymlinkComponent = (components: readonly string[], mode: FileMode): boolean =>
  mode === FILE_MODE.SYMLINK && components.some(matchGitmodulesAliasPart);

/**
 * Mirrors git's `verify_path(path, mode)`: a total function over any string,
 * returning the rejection reason (or `undefined` when the path is safe to
 * become an index entry). Never throws — each call site shapes its own error
 * vocabulary from the returned reason.
 */
export const verifyPath = (path: string, mode: FileMode): VerifyPathRejection | undefined => {
  if (path.startsWith('/')) return 'absolute-path';
  const components = path.split('/');
  const reason = findComponentRejection(components);
  if (reason !== undefined) return reason;
  return hasGitmodulesSymlinkComponent(components, mode) ? 'gitmodules-not-regular' : undefined;
};
