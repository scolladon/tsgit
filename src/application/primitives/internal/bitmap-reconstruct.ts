/**
 * XOR-chain reconstruction of a pack bitmap's per-commit reachability
 * entries. Chains are long and shallow-stepped (most links are
 * `xorOffset === 1`, so resolving one far entry can touch a hundred
 * predecessors) — reconstruction is ITERATIVE, never recursive, and backed
 * by a bounded LRU created fresh per closure call, never hung off a
 * `Context`.
 */
import {
  type BitmapEntryHeader,
  createLruCache,
  foldEwahStream,
  type LruCache,
  type PackBitmap,
} from '../../../domain/storage/index.js';

/** Bound on how many reconstructed commit bit sets a single closure call may
 *  keep resident in its LRU. Each reconstructed set is `laneCount * 4`
 *  bytes; caching every one of `entryCount` bitmap entries would cost
 *  `entryCount * objectCount / 8` bytes — unbounded with repository size,
 *  the one place in this design where an innocent-looking memo is a memory
 *  bomb. 8 MiB holds roughly 2000 reconstructed sets for a 1M-object
 *  repository (`1_000_000 objects / 8 bits ≈ 125_000` bytes each), or every
 *  entry of a much smaller one — generous headroom without ever
 *  approaching the unbounded case. */
const RECONSTRUCTION_CACHE_MAX_BYTES = 8 * 1024 * 1024;

export interface ReconstructionContext {
  readonly bitmap: PackBitmap;
  readonly headers: ReadonlyArray<BitmapEntryHeader>;
  readonly laneCount: number;
  readonly cache: LruCache<Uint32Array>;
}

/** Fresh state for one closure call — never shared across calls, never
 *  cached on a `Context` (see the module doc). */
export function createReconstructionContext(
  bitmap: PackBitmap,
  headers: ReadonlyArray<BitmapEntryHeader>,
  laneCount: number,
): ReconstructionContext {
  return {
    bitmap,
    headers,
    laneCount,
    cache: createLruCache<Uint32Array>(RECONSTRUCTION_CACHE_MAX_BYTES),
  };
}

/**
 * Resolves entry `entryIndex`'s reachability bit set. Walks `xorOffset`
 * links backwards ITERATIVELY until it reaches a zero-offset terminator or
 * a cached reconstruction, then folds forward into one reused
 * `Uint32Array`, caching each newly-resolved index along the way so any of
 * them is an O(1) hit on a later call.
 */
export function reconstructEntry(rc: ReconstructionContext, entryIndex: number): Uint32Array {
  const direct = rc.cache.get(String(entryIndex));
  if (direct !== undefined) return direct;

  const chain: number[] = [entryIndex];
  let base: Uint32Array | undefined;
  let cursor = entryIndex;
  for (;;) {
    const header = rc.headers[cursor] as BitmapEntryHeader;
    if (header.xorOffset === 0) break;
    const parent = cursor - header.xorOffset;
    const cachedParent = rc.cache.get(String(parent));
    if (cachedParent !== undefined) {
      base = cachedParent;
      break;
    }
    chain.push(parent);
    cursor = parent;
  }

  const working = base === undefined ? new Uint32Array(rc.laneCount) : base.slice();
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const idx = chain[i] as number;
    const header = rc.headers[idx] as BitmapEntryHeader;
    foldEwahStream(
      rc.bitmap._bytes,
      rc.bitmap._view,
      header.stream,
      working,
      header.xorOffset === 0 ? 'or' : 'xor',
    );
    rc.cache.set(String(idx), working.slice(), working.byteLength);
  }
  return working;
}

export function orInto(into: Uint32Array, from: Uint32Array): void {
  for (let lane = 0; lane < into.length; lane += 1) {
    into[lane] = (into[lane]! | from[lane]!) >>> 0;
  }
}
