// ---------------------------------------------------------------------------
// Exit-code bits (pinned against real git 2.54.0)
// bit 1 = generic fsck error: content-ERROR, strict-upgraded WARN, corrupt, hash-mismatch
// bit 2 = missing / broken-link / ref→absent-sha
// bit 8 = refs-verify content failure (3c)
// ---------------------------------------------------------------------------

export const EXIT_CONTENT_ERROR = 1;
export const EXIT_CORRUPT = 1;
export const EXIT_HASH_MISMATCH = 1;
export const EXIT_MISSING = 2;
export const EXIT_REFS_CONTENT = 8;
