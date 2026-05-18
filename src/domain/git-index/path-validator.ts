/**
 * Path-segment safety check for git index entries.
 *
 * Called from `parseIndex` (Phase 13.7) before constructing the branded
 * `FilePath`. Downstream consumers can then trust that any `FilePath`
 * value obtained from a parsed `GitIndex` is free of `..`, `.`, empty
 * segments, and leading-slash absolute paths.
 *
 * The throw is shaped as `INVALID_INDEX_ENTRY` so the parser's error
 * vocabulary stays consistent.
 */
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
export const NO_PARSER_OFFSET = -1;

const UNSAFE_SEGMENTS: ReadonlySet<string> = new Set(['', '.', '..']);

// Bidirectional / isolate Unicode controls. Allowing these in index paths
// is a known social-engineering vector: U+202E (right-to-left override)
// can disguise `evil.exe` as `exe.libtrust` in terminal output and log
// lines. Reject them at parse time so the library never produces a
// FilePath value containing them.
const BIDI_CONTROLS: ReadonlySet<number> = new Set([
  0x202a,
  0x202b,
  0x202c,
  0x202d,
  0x202e, // LRE/RLE/PDF/LRO/RLO
  0x2066,
  0x2067,
  0x2068,
  0x2069, // LRI/RLI/FSI/PDI
]);

const reasonFor = (segment: string): string => {
  if (segment === '') return 'empty segment rejected';
  if (segment === '.') return "'.' segment rejected";
  return "'..' segment rejected";
};

const findUnsafeChar = (
  path: string,
): { readonly index: number; readonly reason: string } | undefined => {
  for (let i = 0; i < path.length; i += 1) {
    const code = path.charCodeAt(i);
    // 0x00 is filtered upstream by the NUL terminator scan; we re-assert
    // for callers that bypass parseIndex.
    if (code === 0x5c /* '\' */) return { index: i, reason: 'backslash rejected' };
    if (code < 0x20 || code === 0x7f) {
      return { index: i, reason: 'control character rejected' };
    }
    if (BIDI_CONTROLS.has(code)) {
      return { index: i, reason: 'bidi control character rejected' };
    }
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
 * - Leading `/` (absolute path).
 * - `..`, `.`, or empty segments.
 * - Backslash (`\`) anywhere — Windows separator that would otherwise
 *   produce post-normalisation `..` traversals that the segment check
 *   misses.
 * - C0/C1 control characters and BIDI / isolate Unicode controls —
 *   defends against terminal-rendering attacks (U+202E etc.).
 *
 * The error `reason` deliberately does NOT echo the offending path
 * verbatim. Index entries can carry attacker-supplied paths up to
 * 0xfff bytes long (e.g., from a hostile remote's pack stream);
 * embedding the path in `reason` would amplify log volume and reflect
 * untrusted content.
 */
export const validateIndexPath = (path: string, offset: number): void => {
  if (path.startsWith('/')) {
    throw invalidIndexEntry(offset, 'absolute path rejected');
  }
  const unsafeChar = findUnsafeChar(path);
  if (unsafeChar !== undefined) {
    throw invalidIndexEntry(offset, unsafeChar.reason);
  }
  for (const segment of path.split('/')) {
    if (UNSAFE_SEGMENTS.has(segment)) {
      throw invalidIndexEntry(offset, reasonFor(segment));
    }
  }
};
