import { splitAtSlash } from '../git-index/index-path-key.js';
import { decodePreservingBom } from '../objects/encoding.js';
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

const ASCII_LIMIT = 0x80;
const CONTINUATION_MIN = 0x80;
const CONTINUATION_MAX = 0xbf;
const TWO_BYTE_LEAD_MIN = 0xc2;
const TWO_BYTE_LEAD_MAX = 0xdf;
const THREE_BYTE_LEAD_MIN = 0xe0;
const THREE_BYTE_LEAD_MAX = 0xef;
const FOUR_BYTE_LEAD_MIN = 0xf0;
const FOUR_BYTE_LEAD_MAX = 0xf4;
const THREE_BYTE_LEAD_OVERLONG = 0xe0;
const THREE_BYTE_OVERLONG_SECOND_MIN = 0xa0;
const THREE_BYTE_LEAD_SURROGATE = 0xed;
const THREE_BYTE_SURROGATE_SECOND_MAX = 0x9f;
const THREE_BYTE_LEAD_NON_CHARACTER = 0xef;
const NON_CHARACTER_SECOND = 0xbf;
const NON_CHARACTER_THIRD_MIN = 0xbe;
const FOUR_BYTE_LEAD_OVERLONG = 0xf0;
const FOUR_BYTE_OVERLONG_SECOND_MIN = 0x90;
const FOUR_BYTE_LEAD_BEYOND_UNICODE = 0xf4;
const FOUR_BYTE_BEYOND_SECOND_MAX = 0x8f;
const BMP_LAST_MINUS_ONE = 0xfffe;
const BMP_LAST = 0xffff;
const ASCII_BACKSLASH_BYTE = 0x5c;

const isContinuation = (byte: number | undefined): boolean =>
  byte !== undefined && byte >= CONTINUATION_MIN && byte <= CONTINUATION_MAX;

const leadLength = (lead: number): number => {
  if (lead < ASCII_LIMIT) return 1;
  if (lead >= TWO_BYTE_LEAD_MIN && lead <= TWO_BYTE_LEAD_MAX) return 2;
  if (lead >= THREE_BYTE_LEAD_MIN && lead <= THREE_BYTE_LEAD_MAX) return 3;
  if (lead >= FOUR_BYTE_LEAD_MIN && lead <= FOUR_BYTE_LEAD_MAX) return 4;
  return 0;
};

const isRejectedSecondByte = (lead: number, second: number): boolean =>
  (lead === THREE_BYTE_LEAD_OVERLONG && second < THREE_BYTE_OVERLONG_SECOND_MIN) ||
  (lead === THREE_BYTE_LEAD_SURROGATE && second > THREE_BYTE_SURROGATE_SECOND_MAX) ||
  (lead === FOUR_BYTE_LEAD_OVERLONG && second < FOUR_BYTE_OVERLONG_SECOND_MIN) ||
  (lead === FOUR_BYTE_LEAD_BEYOND_UNICODE && second > FOUR_BYTE_BEYOND_SECOND_MAX);

const isNonCharacterTail = (bytes: Uint8Array, at: number): boolean =>
  bytes[at] === THREE_BYTE_LEAD_NON_CHARACTER &&
  bytes[at + 1] === NON_CHARACTER_SECOND &&
  (bytes[at + 2] as number) >= NON_CHARACTER_THIRD_MIN;

/** Length of the sequence git's `pick_one_utf8_char` accepts at `at`, or 0 when it rejects. */
const acceptedSequenceLength = (bytes: Uint8Array, at: number): number => {
  const length = leadLength(bytes[at] as number);
  if (length === 0 || at + length > bytes.length) return 0;
  for (let i = 1; i < length; i += 1) {
    if (!isContinuation(bytes[at + i])) return 0;
  }
  if (length > 2 && isRejectedSecondByte(bytes[at] as number, bytes[at + 1] as number)) return 0;
  return length === 3 && isNonCharacterTail(bytes, at) ? 0 : length;
};

/** Offset of the first sequence git's `pick_one_utf8_char` rejects, else `bytes.length`. */
export const gitPickerValidPrefix = (bytes: Uint8Array): number => {
  let at = 0;
  while (at < bytes.length) {
    const length = acceptedSequenceLength(bytes, at);
    if (length === 0) return at;
    at += length;
  }
  return bytes.length;
};

const firstNonCharacter = (part: string): number => {
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
  if (candidate === part && !hasIgnorableCodepoint(part)) return false;
  // HFS folds case only; trailing dots and spaces are an NTFS rule.
  return stripIgnorableCodepoints(candidate).toLowerCase() === target;
};

const splitBytesAtBackslash = (bytes: Uint8Array): Uint8Array[] => {
  const parts: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== ASCII_BACKSLASH_BYTE) continue;
    parts.push(bytes.subarray(start, i));
    start = i + 1;
  }
  parts.push(bytes.subarray(start));
  return parts;
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

const matchAliasPart = (part: string, partBytes?: Uint8Array): VerifyPathRejection | undefined => {
  const { candidate, hasStream } = splitAtStream(part);
  const normalized = normalizeAliasCandidate(candidate);
  if (normalized === DOTGIT) return hasStream ? 'dotgit-ntfs-stream' : 'dotgit-alias';
  if (normalized === NTFS_SHORT_NAME) {
    return hasStream ? 'dotgit-ntfs-stream' : 'dotgit-ntfs-alias';
  }
  return hfsAlias(part, partBytes, DOTGIT) ? 'dotgit-hfs-alias' : undefined;
};

const ASCII_DOT = 0x2e;
const ASCII_UPPER_G = 0x47;
const ASCII_LOWER_G = 0x67;
const ASCII_BACKSLASH = 0x5c;
const ASCII_MAX = 0x7f;

/**
 * True when `component` cannot possibly normalise (case-fold, trailing
 * dot/space strip, or ignorable-codepoint strip) to `.git`, `git~1`, or
 * either of their stream/alias forms — every target of {@link matchAliasPart}
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
  // Stryker disable next-line BooleanLiteral: equivalent — an empty component can never equal DOTGIT/NTFS_SHORT_NAME either way; isDotGitAlias('') is false whether this fast path fires or falls through to matchAliasPart('') (verified: 'empty component' case in verify-path.test.ts passes unmutated).
  if (component.length === 0) return false;
  const first = component.charCodeAt(0);
  if (first === ASCII_DOT || first === ASCII_UPPER_G || first === ASCII_LOWER_G) return false;
  for (let i = 0; i < component.length; i += 1) {
    const code = component.charCodeAt(i);
    if (code > ASCII_MAX || code === ASCII_BACKSLASH) return false;
  }
  return true;
};

// The `\` split exists only to feed this scan (`.git\config` reads as two
// parts, `.git` and `config`) — a bare backslash is never a rejection. Most
// components carry no backslash at all, so skip the allocating split for them.
const matchAliasComponent = (
  component: string,
  componentBytes?: Uint8Array,
): VerifyPathRejection | undefined => {
  if (isObviouslyNotAnAlias(component)) return undefined;
  if (component.indexOf('\\') === -1) return matchAliasPart(component, componentBytes);
  const partBytes = componentBytes && splitBytesAtBackslash(componentBytes);
  for (const [index, part] of component.split('\\').entries()) {
    const reason = matchAliasPart(part, partBytes?.[index]);
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
const matchGitmodulesAliasPart = (component: string, componentBytes?: Uint8Array): boolean => {
  const { candidate } = splitAtStream(component);
  const normalized = normalizeAliasCandidate(candidate);
  if (normalized === GITMODULES) return true;
  if (GITMOD_NTFS_SHORT_NAME.test(normalized)) return true;
  if (GITMOD_NTFS_HASHED_SHORT_NAME.test(normalized)) return true;
  return hfsAlias(component, componentBytes, GITMODULES);
};

// CVE-2018-11235 hardening: an entry whose mode is a symlink must not carry
// a `.gitmodules` path component (or one of its NTFS/HFS-obscured aliases)
// ANYWHERE — not only as the leaf. Verified against git (`update-index --add
// --cacheinfo 120000,<blob>,.gitmodules/foo` → `error: Invalid path`): the
// check runs once per path component, gated on the entry's own mode, exactly
// like the `.git`-alias scan above — a `.gitmodules` directory holding an
// unrelated symlinked leaf is refused exactly as a symlinked `.gitmodules`
// leaf itself is.
const hasGitmodulesSymlinkComponent = (
  components: readonly string[],
  mode: FileMode,
  bytes?: readonly Uint8Array[],
): boolean =>
  mode === FILE_MODE.SYMLINK &&
  components.some((component, index) => matchGitmodulesAliasPart(component, bytes?.[index]));

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
  return hasGitmodulesSymlinkComponent(components, mode, bytes)
    ? 'gitmodules-not-regular'
    : undefined;
};
