/**
 * git's pack name hash — a fold over a path's raw bytes that clusters
 * objects sharing a basename tail, used to order delta candidates.
 * See `pack-objects.h`'s `pack_name_hash` (git 2.55.0): the fold shifts
 * the accumulator right by two bits per byte, so effectively only the last
 * sixteen or so non-space bytes shape the final value — bytes older than
 * that rarely, but can still, leave a one-bit trace via the shift's integer
 * rounding.
 */

/** git's own `sane_ctype` space bits, not C's `isspace` — vertical tab and
 *  form feed carry only the control bit and are hashed, not skipped. */
const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const SPACE = 0x20;
const BYTE_VALUES = 256;

const GIT_SPACE = new Uint8Array(BYTE_VALUES);
GIT_SPACE[TAB] = 1;
GIT_SPACE[LINE_FEED] = 1;
GIT_SPACE[CARRIAGE_RETURN] = 1;
GIT_SPACE[SPACE] = 1;

export const PACK_NAME_HASH_SEED = 0;

/** The hash git gives an object it has no path for — commits, tags, a root
 *  tree, and every object enumerated from a reachability bitmap, which
 *  encodes types and bits but never names. Numerically equal to
 *  `PACK_NAME_HASH_SEED` and semantically unrelated to it: the seed is where
 *  a fold starts, this is the answer when there is nothing to fold. Naming
 *  them apart keeps a call site honest about which one it means. */
export const PACK_NAME_HASH_PATHLESS = 0;

/** The path separator, folded between segments so an incremental
 *  per-segment fold agrees byte-for-byte with folding the whole joined
 *  path at once. */
const SLASH = Uint8Array.of(0x2f);

/** Fold one path segment onto a running state, inserting the separator for
 *  every segment after the first. Shared by the tree walker and the bundle
 *  enumerator so the two cannot drift — and taken through the `PathHasher`
 *  seam rather than the concrete fold, so a second hash version stays the
 *  one-module port it is meant to be. */
export function foldPathSegment(
  hasher: PathHasher,
  state: number,
  nameBytes: Uint8Array,
  isRoot: boolean,
): number {
  const base = isRoot ? state : hasher.fold(state, SLASH);
  return hasher.fold(base, nameBytes);
}

/** The one-method seam a byte-folding path hasher implements — the domain
 *  owns the pack-specific constant, so a walker can fold through it without
 *  importing outward. */
export interface PathHasher {
  readonly seed: number;
  fold(state: number, bytes: Uint8Array): number;
}

export function foldPackNameHash(state: number, bytes: Uint8Array): number {
  let hash = state;
  // Indexed rather than `for...of`: iterating a Uint8Array goes through the
  // TypedArray iterator protocol, allocating an iterator and a result object
  // per byte until the function tiers up. This is the innermost loop of the
  // whole packer.
  for (let i = 0; i < bytes.length; i += 1) {
    const c = bytes[i]!;
    if (GIT_SPACE[c] === 1) continue;
    hash = ((hash >>> 2) + (c << 24)) >>> 0;
  }
  return hash;
}

export const packNameHash = (pathBytes: Uint8Array): number =>
  foldPackNameHash(PACK_NAME_HASH_SEED, pathBytes);

export const PACK_NAME_HASH_V1: PathHasher = { seed: PACK_NAME_HASH_SEED, fold: foldPackNameHash };
