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

/**
 * A NUL byte (0x00) is not a git-parity rejection — canonical git's
 * `verify_path` never even sees this byte, because a NUL always terminates
 * the argv string / tree-entry name / index path field before `verify_path`
 * runs. This check exists purely because the index FORMAT cannot represent
 * a NUL inside a path: `index-parser.ts` (`findNul`) and `index-writer.ts`
 * (implicit zero-padding) both treat the first 0x00 after a path as its
 * terminator, so an embedded NUL would round-trip as a silently TRUNCATED
 * path rather than a rejected one. No path sourced through `parseIndex` or
 * a tree walk can ever carry one — both formats NUL-terminate names before
 * this validator runs — so this only guards a hand-built `IndexEntry` (test
 * fixture, future in-memory builder) that bypassed the parser.
 *
 * Everything else — backslash, C0/C1 controls, BIDI/isolate Unicode
 * controls — is POSIX-legal to git (pinned against git 2.55: `update-index
 * --add --cacheinfo` and a real `git add` of an on-disk file both STAGE
 * these bytes) and is deliberately NOT rejected here, so the parse boundary
 * and the write boundary (`add.ts`'s `stageFromStat`) agree with each other
 * and with canonical git.
 */
const unsafeReason = (path: string): string | undefined =>
  path.includes('\0') ? 'NUL byte rejected' : undefined;

/**
 * Throws `INVALID_INDEX_ENTRY` if `path` is unsafe. The `offset` is the
 * byte offset of the failing entry's header — propagated into the error
 * `data` so the caller can localise the failure inside the index file.
 *
 * Rejection rules (every check at the input boundary so downstream
 * consumers can trust the branded `FilePath` value):
 *
 * - A NUL byte anywhere — not a git-parity rule but an index-FORMAT
 *  constraint (see `unsafeReason` above); real git never validates this
 *  byte because it can never reach `verify_path` in the first place.
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
