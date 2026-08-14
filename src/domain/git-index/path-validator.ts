/**
 * Path-segment safety check for git index entries.
 *
 * Called from `parseIndex` before constructing the branded
 * `FilePath`. Downstream consumers can then trust that any `FilePath`
 * value obtained from a parsed `GitIndex` is free of `..`, `.`, empty
 * segments, and leading-slash absolute paths.
 *
 * The throw is shaped as `INVALID_INDEX_ENTRY` so the parser's error
 * vocabulary stays consistent.
 */
import type { FileMode } from '../objects/index.js';
import { type VerifyPathRejection, verifyPath } from '../path/verify-path.js';
import { invalidIndexEntry } from './error.js';

/**
 * Sentinel offset for callers that re-use `validateIndexPath` outside the
 * canonical `parseIndex` flow (e.g., defence-in-depth checks in
 * `synthesizeTreeFromIndex`). When this value appears in
 * `INVALID_INDEX_ENTRY.data.offset`, the entry was NOT sourced from a
 * parsed byte buffer and the offset has no meaningful file position.
 * Callers that try to localise the failure inside an index file should
 * treat this value as "no offset available".
 */
export const NO_PARSER_OFFSET = -1 as const;

// Bidirectional / isolate Unicode controls per Unicode TR9 + RFC 9839.
// Allowing these in index paths is a known social-engineering vector:
// U+202E (right-to-left override) can disguise `evil.exe` as
// `exe.libtrust` in terminal output and log lines. Reject them at
// parse time so the library never produces a FilePath value containing
// them.
const BIDI_CONTROLS: ReadonlySet<number> = new Set([
  0x061c, // ALM (Arabic Letter Mark)
  0x200e, // LRM (Left-to-Right Mark)
  0x200f, // RLM (Right-to-Left Mark)
  0x202a, // LRE
  0x202b, // RLE
  0x202c, // PDF
  0x202d, // LRO
  0x202e, // RLO
  0x2066, // LRI
  0x2067, // RLI
  0x2068, // FSI
  0x2069, // PDI
]);

const reasonFor = (segment: string): string => {
  if (segment === '') return 'empty segment rejected';
  if (segment === '.') return "'.' segment rejected";
  return "'..' segment rejected";
};

// verifyPath owns every shape (absolute/empty/dot/dotdot), alias, and
// gitmodules family reachable through validateIndexPath — the table stays
// total over VerifyPathRejection so the compiler enforces a distinct string
// for every reason verifyPath can return at this call site.
const VERIFY_PATH_REASON: Record<VerifyPathRejection, string> = {
  'absolute-path': 'absolute path rejected',
  'empty-segment': reasonFor(''),
  'dot-segment': reasonFor('.'),
  'dotdot-segment': reasonFor('..'),
  'dotgit-alias': "'.git' component rejected",
  'dotgit-ntfs-alias': "'git~1' NTFS short name rejected",
  'dotgit-ntfs-stream': "'.git' NTFS alternate data stream rejected",
  'dotgit-hfs-alias': "'.git' HFS+ ignorable-codepoint alias rejected",
  'gitmodules-not-regular': "'.gitmodules' must not be a symlink",
};

const isControlChar = (code: number): boolean => code < 0x20 || (code >= 0x7f && code <= 0x9f);

const unsafeReason = (path: string): string | undefined => {
  // Stryker disable next-line EqualityOperator: equivalent — `i <= path.length` adds one iteration where charCodeAt returns NaN, which fails every check (NaN comparisons are always false), so behavior is unchanged.
  for (let i = 0; i < path.length; i += 1) {
    const code = path.charCodeAt(i);
    // 0x00 is filtered upstream by the NUL terminator scan; we re-assert
    // for callers that bypass parseIndex.
    if (code === 0x5c /* '\' */) return 'backslash rejected';
    if (isControlChar(code)) return 'control character rejected';
    if (BIDI_CONTROLS.has(code)) return 'bidi control character rejected';
  }
  return undefined;
};

/**
 * Throws `INVALID_INDEX_ENTRY` if `path` is unsafe. The `offset` is the
 * byte offset of the failing entry's header — propagated into the error
 * `data` so the caller can localise the failure inside the index file.
 *
 * Rejection rules (every check at the input boundary so downstream
 * consumers can trust the branded `FilePath` value):
 *
 * - Backslash (`\`) anywhere — Windows separator that would otherwise
 *  produce post-normalisation `..` traversals that the shape check
 *  misses.
 * - C0/C1 control characters and BIDI / isolate Unicode controls —
 *  defends against terminal-rendering attacks (U+202E etc.).
 * - Leading `/` (absolute path); `..`, `.`, or empty segments; `.git`
 *  and its NTFS (`git~1`, `.git:`-stream) / HFS+ (ignorable-codepoint)
 *  aliases; and a `.gitmodules` component whose entry `mode` is a
 *  symlink (CVE-2018-11235 hardening) — all delegated to a single,
 *  git-faithful, first-component-wins pass over the path: `verifyPath`
 *  in `../path/verify-path.js`.
 *
 * The error `reason` deliberately does NOT echo the offending path
 * verbatim. Index entries can carry attacker-supplied paths up to
 * 0xfff bytes long (e.g., from a hostile remote's pack stream);
 * embedding the path in `reason` would amplify log volume and reflect
 * untrusted content.
 */
export const validateIndexPath = (path: string, offset: number, mode: FileMode): void => {
  const reason = unsafeReason(path);
  if (reason !== undefined) {
    throw invalidIndexEntry(offset, reason);
  }
  const rejection = verifyPath(path, mode);
  if (rejection !== undefined) {
    throw invalidIndexEntry(offset, VERIFY_PATH_REASON[rejection]);
  }
};
