/**
 * Pure grammar check for `HEAD` file content: text in, verdict out, no I/O.
 * Content is valid iff it parses as a hex object id of width 40 or 64
 * (detached HEAD, SHA-1 or SHA-256), OR it begins `ref:` and the first
 * whitespace-delimited token after that prefix begins `refs/` (a symbolic
 * ref; the refname past the prefix is never format-checked here — `refs/
 * heads/../evil` is accepted, exactly as the referenced ref would be
 * validated, or not, when it is actually resolved).
 *
 * One deliberate divergence from real git: git also accepts a `HEAD` that is
 * a *symlink* whose link text begins `refs/`, even when the symlink target
 * does not exist. This module only ever sees the string a caller already
 * read back (following any symlink), so a dangling `HEAD` symlink can never
 * reach it — the caller's read already failed and it never calls in. A
 * `HEAD` symlink to an existing, valid target still comes through here as
 * ordinary content and is accepted.
 */

// Matches the sibling hash-width regexes elsewhere in the domain
// (fsck's tag/commit validators, the bundle header parser): one named
// pattern per accepted width. An optional single trailing newline is
// tolerated — real git always writes a detached HEAD as `<hex>\n`.
const SHA1_HEX_RE = /^[0-9a-f]{40}\n?$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}\n?$/;

const REF_PREFIX = 'ref:';
const REFS_NAMESPACE_PREFIX = 'refs/';

const isHexObjectId = (content: string): boolean =>
  SHA1_HEX_RE.test(content) || SHA256_HEX_RE.test(content);

const isSymbolicRef = (content: string): boolean => {
  if (!content.startsWith(REF_PREFIX)) return false;
  // split(/\s/) on any string yields at least one element, so index 0 always exists.
  const token = content.slice(REF_PREFIX.length).trimStart().split(/\s/)[0] as string;
  return token.startsWith(REFS_NAMESPACE_PREFIX);
};

export const isValidHeadContent = (content: string): boolean =>
  isHexObjectId(content) || isSymbolicRef(content);
