// ---------------------------------------------------------------------------
// Exit-code bits (bits 1/2/8 pinned against real git 2.54.0; bits 4/32/64 against 2.55.0)
// bit 1  = generic fsck error: content-ERROR, strict-upgraded WARN, corrupt, hash-mismatch
// bit 2  = missing / broken-link / ref→absent-sha
// bit 8  = refs-verify content failure (3c)
// bit 4  = pack inaccessible / index not opened (git's ERROR_PACK)
// bit 32 = multi-pack-index verification failure (git's ERROR_MULTI_PACK_INDEX)
// bit 64 = reverse index unusable               (git's ERROR_PACK_REV_INDEX)
// ---------------------------------------------------------------------------

export const EXIT_CONTENT_ERROR = 1;
export const EXIT_CORRUPT = 1;
export const EXIT_HASH_MISMATCH = 1;
export const EXIT_MISSING = 2;
export const EXIT_REFS_CONTENT = 8;
export const EXIT_PACK = 4;
export const EXIT_MULTI_PACK_INDEX = 32;
/**
 * tsgit has no reverse-index (`.rev`) reader. This bit is emitted as a
 * deterministic consequence of an unusable pack index — real git emits it
 * for the same fault with no `.rev` file on disk — not because tsgit reads
 * or verifies one. The name is a promise the code does not yet keep.
 */
export const EXIT_PACK_REV_INDEX = 64;
