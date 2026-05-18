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

const UNSAFE_SEGMENTS: ReadonlySet<string> = new Set(['', '.', '..']);

const reasonFor = (segment: string): string => {
  if (segment === '') return 'empty segment rejected';
  if (segment === '.') return "'.' segment rejected";
  return "'..' segment rejected";
};

/**
 * Throws `INVALID_INDEX_ENTRY` if `path` is unsafe. The `offset` is the
 * byte offset of the failing entry's header — propagated into the error
 * `data` so the caller can localise the failure inside the index file.
 *
 * The error `reason` deliberately does NOT echo the offending path
 * verbatim. Index entries can carry attacker-supplied paths up to
 * 0xfff bytes long (e.g., from a hostile remote's pack stream); the
 * `offset` is the right way to localise, and embedding the path in
 * `reason` would amplify log volume and reflect untrusted content.
 */
export const validateIndexPath = (path: string, offset: number): void => {
  if (path.startsWith('/')) {
    throw invalidIndexEntry(offset, 'absolute path rejected');
  }
  for (const segment of path.split('/')) {
    if (UNSAFE_SEGMENTS.has(segment)) {
      throw invalidIndexEntry(offset, reasonFor(segment));
    }
  }
};
