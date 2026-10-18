import { splitAtSlash } from '../git-index/index-path-key.js';
import { decodePreservingBom, encode, wellFormedSequenceLength } from '../objects/encoding.js';
import { FILE_MODE, type FileMode } from '../objects/file-mode.js';
import { matchesNtfsDotgitAlias } from '../objects/tree-entry-bytes.js';

export type VerifyPathRejection =
  | 'absolute-path'
  | 'empty-segment'
  | 'dot-segment'
  | 'dotdot-segment'
  | 'dotgit-alias'
  | 'dotgit-ntfs-alias'
  | 'dotgit-ntfs-stream'
  | 'dotgit-hfs-alias'
  | 'gitmodules-not-regular'
  | 'backslash';

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

const THREE_BYTE_LEAD_NON_CHARACTER = 0xef;
const NON_CHARACTER_SECOND = 0xbf;
const NON_CHARACTER_THIRD_MIN = 0xbe;
const BMP_LAST_MINUS_ONE = 0xfffe;
const BMP_LAST = 0xffff;

const isNonCharacterTail = (bytes: Uint8Array, at: number): boolean =>
  bytes[at] === THREE_BYTE_LEAD_NON_CHARACTER &&
  bytes[at + 1] === NON_CHARACTER_SECOND &&
  (bytes[at + 2] as number) >= NON_CHARACTER_THIRD_MIN;

/** Length of the sequence git's `pick_one_utf8_char` accepts at `at`, or 0 when it rejects. */
const acceptedSequenceLength = (bytes: Uint8Array, at: number): number => {
  const length = wellFormedSequenceLength(bytes, at);
  // The non-character tail starts with a three-byte lead, so it only ever meets a three-byte length or 0.
  return isNonCharacterTail(bytes, at) ? 0 : length;
};

/** Offset of the first sequence git's `pick_one_utf8_char` rejects, else `bytes.length`. */
export const gitPickerValidPrefix = (bytes: Uint8Array): number => {
  let at = 0;
  // Stryker disable next-line EqualityOperator: equivalent — at bytes.length the lead reads undefined, acceptedSequenceLength is 0 and the loop returns at, which is bytes.length.
  while (at < bytes.length) {
    const length = acceptedSequenceLength(bytes, at);
    if (length === 0) return at;
    at += length;
  }
  return bytes.length;
};

const firstNonCharacter = (part: string): number => {
  // Stryker disable next-line EqualityOperator: equivalent — charCodeAt(part.length) is NaN, matches neither non-character, so the loop still ends at part.length.
  for (let i = 0; i < part.length; i += 1) {
    const code = part.charCodeAt(i);
    if (code === BMP_LAST_MINUS_ONE || code === BMP_LAST) return i;
  }
  return part.length;
};

// git hands the HFS check only the bytes its UTF-8 picker accepts, so the
// candidate ends where the picker stops, not where the lossy view does.
const hfsCandidate = (part: string, partBytes?: Uint8Array): string =>
  partBytes === undefined
    ? part.slice(0, firstNonCharacter(part))
    : decodePreservingBom(partBytes.subarray(0, gitPickerValidPrefix(partBytes)));

const hfsAlias = (part: string, partBytes: Uint8Array | undefined, target: string): boolean => {
  const candidate = hfsCandidate(part, partBytes);
  // Stryker disable next-line ConditionalExpression: equivalent — when it holds the result is part.toLowerCase() === target, which the .git caller's normalizeAliasCandidate check and the .gitmodules caller's exact-name check already caught before calling, so it is false here.
  if (candidate === part && !hasIgnorableCodepoint(part)) return false;
  // HFS folds case only; trailing dots and spaces are an NTFS rule.
  return stripIgnorableCodepoints(candidate).toLowerCase() === target;
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

const matchNtfsPart = (part: string): VerifyPathRejection | undefined => {
  const { candidate, hasStream } = splitAtStream(part);
  const normalized = normalizeAliasCandidate(candidate);
  if (normalized === DOTGIT) return hasStream ? 'dotgit-ntfs-stream' : 'dotgit-alias';
  if (normalized === NTFS_SHORT_NAME) {
    return hasStream ? 'dotgit-ntfs-stream' : 'dotgit-ntfs-alias';
  }
  return undefined;
};

const ASCII_DOT = 0x2e;
const ASCII_UPPER_G = 0x47;
const ASCII_LOWER_G = 0x67;
const ASCII_BACKSLASH = 0x5c;
const ASCII_SLASH = 0x2f;
const ASCII_MAX = 0x7f;

/**
 * True when `component` cannot possibly normalise (case-fold, trailing
 * dot/space strip, or ignorable-codepoint strip) to `.git`, `git~1`, or
 * either of their stream/alias forms — every target of {@link matchNtfsPart}
 * begins with `.` or `g`/`G` and is pure ASCII. A component whose first
 * character is neither, that carries no backslash (which could re-anchor a
 * LATER split part's own first character), and no byte ≥ 0x80 (every
 * {@link IGNORABLE_CODEPOINTS} entry is ≥ 0x80, and an ignorable codepoint
 * hiding at the FRONT of a component is exactly what turns a
 * non-alias-looking prefix into `.git` once stripped) is provably safe to
 * skip the allocating split/regex/case-fold machinery below — trailing
 * dot/space stripping only removes characters from the END, so it can never
 * change what the FIRST character is.
 */
const isObviouslyNotAnAlias = (component: string): boolean => {
  // Stryker disable next-line BooleanLiteral: equivalent — an empty component can never equal DOTGIT/NTFS_SHORT_NAME either way; isDotGitAlias('') is false whether this fast path fires or falls through to matchAliasComponent('') (verified: 'empty component' case in verify-path.test.ts passes unmutated).
  if (component.length === 0) return false;
  const first = component.charCodeAt(0);
  if (first === ASCII_DOT || first === ASCII_UPPER_G || first === ASCII_LOWER_G) return false;
  for (let i = 0; i < component.length; i += 1) {
    const code = component.charCodeAt(i);
    if (code > ASCII_MAX || code === ASCII_BACKSLASH) return false;
  }
  return true;
};

// git runs the NTFS scan per backslash part (`.git\config` reads as two parts,
// `.git` and `config`) but hands the HFS check the whole `/` component, so an
// HFS lookalike only matches when the component itself is the alias. git consumes a
// component's first byte untested, so a backslash there opens no part of its own; the
// leading empty part it leaves can never match an alias either.
const ntfsParts = (component: string): readonly string[] => {
  const parts = component.split('\\');
  return component.startsWith('\\') ? parts.slice(2) : parts;
};

const matchAliasComponent = (
  component: string,
  componentBytes?: Uint8Array,
): VerifyPathRejection | undefined => {
  // Stryker disable next-line ConditionalExpression: equivalent — a fast path: a component it admits is all-ASCII, backslash-free and opens with neither . nor g, so both the NTFS and the HFS arms below return undefined for it.
  if (isObviouslyNotAnAlias(component)) return undefined;
  for (const part of ntfsParts(component)) {
    const reason = matchNtfsPart(part);
    if (reason !== undefined) return reason;
  }
  return hfsAlias(component, componentBytes, DOTGIT) ? 'dotgit-hfs-alias' : undefined;
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

const findComponentRejection = (
  components: readonly string[],
  bytes?: readonly Uint8Array[],
): VerifyPathRejection | undefined => {
  for (const [index, component] of components.entries()) {
    const reason = matchShape(component) ?? matchAliasComponent(component, bytes?.[index]);
    if (reason !== undefined) return reason;
  }
  return undefined;
};

// git re-tests the rest of the whole path at each component start and after each
// `\` it reads mid-component. The `.gitmodules` alias must be followed only by
// dots/spaces up to the end or a `:`; any other byte after it, `/` included, defeats
// the match, unlike the `.git` arm. A `\` opening a component is consumed untested.
const opensComponent = (bytes: Uint8Array, at: number): boolean =>
  at === 0 || bytes[at - 1] === ASCII_SLASH;

const isNtfsRetestPoint = (bytes: Uint8Array, at: number): boolean =>
  bytes[at] === ASCII_SLASH || (bytes[at] === ASCII_BACKSLASH && !opensComponent(bytes, at));

const startsNtfsGitmodulesAlias = (bytes: Uint8Array, start: number): boolean =>
  matchesNtfsDotgitAlias(bytes, start, bytes.length, 'gitmodules');

const hasNtfsGitmodulesAlias = (bytes: Uint8Array): boolean =>
  startsNtfsGitmodulesAlias(bytes, 0) ||
  bytes.some((_, at) => isNtfsRetestPoint(bytes, at) && startsNtfsGitmodulesAlias(bytes, at + 1));

// git's `verify_dotfile`: the exact name per `/` component, ASCII case-fold only,
// plus the HFS+ ignorable-codepoint aliases.
const namesGitmodulesComponent = (component: string, componentBytes?: Uint8Array): boolean =>
  component.toLowerCase() === GITMODULES || hfsAlias(component, componentBytes, GITMODULES);

// CVE-2018-11235 hardening: an entry whose mode is a symlink must not carry
// a `.gitmodules` path component (or one of its NTFS/HFS-obscured aliases)
// ANYWHERE — not only as the leaf. The check is gated on the entry's own mode,
// so a `.gitmodules` directory holding an unrelated symlinked leaf is refused
// exactly as a symlinked `.gitmodules` leaf itself is.
const hasGitmodulesSymlinkAlias = (
  pathBytes: Uint8Array,
  components: readonly string[],
  bytes?: readonly Uint8Array[],
): boolean =>
  hasNtfsGitmodulesAlias(pathBytes) ||
  components.some((component, index) => namesGitmodulesComponent(component, bytes?.[index]));

/**
 * Mirrors git's `verify_path(path, mode)`: a total function over any string,
 * returning the rejection reason (or `undefined` when the path is safe to
 * become an index entry). Never throws — each call site shapes its own error
 * vocabulary from the returned reason.
 */
export const verifyPath = (
  path: string,
  mode: FileMode,
  pathBytes?: Uint8Array,
): VerifyPathRejection | undefined => {
  if (path.startsWith('/')) return 'absolute-path';
  const components = path.split('/');
  const bytes = pathBytes && splitAtSlash(pathBytes);
  const reason = findComponentRejection(components, bytes);
  if (reason !== undefined) return reason;
  if (mode !== FILE_MODE.SYMLINK) return undefined;
  return hasGitmodulesSymlinkAlias(pathBytes ?? encode(path), components, bytes)
    ? 'gitmodules-not-regular'
    : undefined;
};

const BACKSLASH = '\\';

/** git for Windows' `verify_path`: `\` is a directory separator there, and every one is refused. */
export const verifyWindowsPath = (
  path: string,
  mode: FileMode,
  pathBytes?: Uint8Array,
): VerifyPathRejection | undefined =>
  path.includes(BACKSLASH) ? 'backslash' : verifyPath(path, mode, pathBytes);
