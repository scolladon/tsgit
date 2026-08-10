// ---------------------------------------------------------------------------
// Exit-code bits (bits 1/2/8 pinned against real git 2.54.0; bits 4/32/64/128 against 2.55.0)
// bit 1   = generic fsck error: content-ERROR, strict-upgraded WARN, corrupt, hash-mismatch
// bit 2   = missing / broken-link / ref→absent-sha
// bit 8   = refs-verify content failure (3c)
// bit 4   = pack inaccessible / index not opened (git's ERROR_PACK)
// bit 32  = multi-pack-index verification failure (git's ERROR_MULTI_PACK_INDEX)
// bit 64  = reverse index unusable, one of two independent causes (git's ERROR_PACK_REV_INDEX)
// bit 128 = a pack's or the in-use multi-pack-index's bitmap trailer checksum disagrees with
//           its bytes — the one message git prints for every cause, structural or not
// ---------------------------------------------------------------------------

export const EXIT_CONTENT_ERROR = 1;
export const EXIT_CORRUPT = 1;
export const EXIT_HASH_MISMATCH = 1;
export const EXIT_MISSING = 2;
export const EXIT_REFS_CONTENT = 8;
export const EXIT_PACK = 4;
export const EXIT_MULTI_PACK_INDEX = 32;
/**
 * A pack's reverse index is unusable, for either of two causes that never
 * double-report for the same pack: the pack's own index could not be
 * loaded, so no reverse index can be derived from it at all
 * (`pack-rev-index-unusable`); or a `.rev` file exists, is readable, and is
 * itself wrong — a bad trailer checksum or a body position that disagrees
 * with what the pack's `.idx` implies (`pack-rev-index-invalid` /
 * `pack-rev-index-position-mismatch`).
 */
export const EXIT_PACK_REV_INDEX = 64;
/**
 * A bitmap's trailing digest disagrees with the bytes that precede it — the
 * pack's own `.bitmap`, or the in-use multi-pack-index's. One cause, one
 * message, no structural check: a restamped structural corruption (wrong
 * magic, wrong version, an absurd entry count, a truncated file, an
 * oversized EWAH word count) never sets this bit, because canonical git's
 * own bitmap obligation is this checksum comparison and nothing else.
 */
export const EXIT_BITMAP = 128;
