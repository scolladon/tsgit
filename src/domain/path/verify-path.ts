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
const NTFS_STREAM_PREFIX = '.git:';
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

const matchAliasPart = (part: string): VerifyPathRejection | undefined => {
  const normalized = normalizeAliasCandidate(part);
  if (normalized === DOTGIT) return 'dotgit-alias';
  if (normalized === NTFS_SHORT_NAME) return 'dotgit-ntfs-alias';
  if (normalized.startsWith(NTFS_STREAM_PREFIX)) return 'dotgit-ntfs-stream';
  const hfsNormalized = normalizeAliasCandidate(stripIgnorableCodepoints(part));
  return hfsNormalized === DOTGIT ? 'dotgit-hfs-alias' : undefined;
};

// The `\` split exists only to feed this scan (`.git\config` reads as two
// parts, `.git` and `config`) — a bare backslash is never a rejection.
const matchAliasComponent = (component: string): VerifyPathRejection | undefined => {
  for (const part of component.split('\\')) {
    const reason = matchAliasPart(part);
    if (reason !== undefined) return reason;
  }
  return undefined;
};

/** True if `component` is `.git` or one of its NTFS/HFS-obscured aliases. */
export const isDotGitAlias = (component: string): boolean =>
  matchAliasComponent(component) !== undefined;

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

// CVE-2018-11235 hardening: a `.gitmodules` entry must not be a symlink
// (a symlinked .gitmodules can point at an attacker-controlled config file).
const isGitmodulesLeaf = (components: readonly string[], mode: FileMode): boolean =>
  components.at(-1) === GITMODULES && mode === FILE_MODE.SYMLINK;

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
  return isGitmodulesLeaf(components, mode) ? 'gitmodules-not-regular' : undefined;
};
