// ---------------------------------------------------------------------------
// Exit-code bits, pinned against real git 2.56.0
// bit 1   = generic fsck error: content-ERROR, strict-upgraded WARN, corrupt, hash-mismatch,
//           and every pack, rev-index, bitmap and multi-pack-index fault
// bit 2   = missing / broken-link / ref→absent-sha
// bit 8   = refs-verify failure: an error-graded `bad-ref` content finding, or a loose ref
//           file the permissions refuse (`cannotReadRef`); OR'd with the missing-entry-point
//           condition (no ref and no index entry resolves to a readable
//           object anywhere in the repository — a whole-repository check,
//           not a per-ref one)
// bit 16  = commit-graph verification failure (git's ERROR_COMMIT_GRAPH)
// ---------------------------------------------------------------------------

export const EXIT_CONTENT_ERROR = 1;
export const EXIT_CORRUPT = 1;
export const EXIT_HASH_MISMATCH = 1;
export const EXIT_MISSING = 2;
export const EXIT_REFS_CONTENT = 8;
/** `git commit-graph verify` failed for some object source (git's ERROR_COMMIT_GRAPH). */
export const EXIT_COMMIT_GRAPH = 16;
