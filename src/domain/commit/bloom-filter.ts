/**
 * Changed-path Bloom filters as git's `bloom.c` builds them for a
 * commit-graph's `BIDX`/`BDAT` chunks: a seeded murmur3 per path (version 1
 * keeps git's original signed-char bug, version 2 reads bytes unsigned),
 * `numHashes` probes stepped by the second seed's hash, and one filter per
 * commit sized `bitsPerEntry` bits for each distinct path — every changed
 * path plus each of its leading directories.
 */

export type BloomHashVersion = 1 | 2;

export interface BloomFilterSettings {
  readonly hashVersion: BloomHashVersion;
  readonly numHashes: number;
  readonly bitsPerEntry: number;
  /** Past this many distinct paths a filter collapses to {@link TOO_LARGE_FILTER}; never written to disk. */
  readonly maxChangedPaths: number;
}

/** git's `DEFAULT_BLOOM_FILTER_SETTINGS`. */
export const DEFAULT_BLOOM_FILTER_SETTINGS: BloomFilterSettings = {
  hashVersion: 1,
  numHashes: 7,
  bitsPerEntry: 10,
  maxChangedPaths: 512,
};

const SEED_0 = 0x293ae76f;
const SEED_1 = 0x7e646e2c;
const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;
const R1 = 15;
const R2 = 13;
const M = 5;
const N = 0xe6546b64;
const FINAL_MULTIPLIER_1 = 0x85ebca6b;
const FINAL_MULTIPLIER_2 = 0xc2b2ae35;
const BLOCK_SIZE = 4;
const BITS_PER_WORD = 8;
const SLASH = 0x2f;
const TOO_LARGE_FILTER = 0xff;

type ByteReader = (byte: number) => number;

const unsignedByte: ByteReader = (byte) => byte;
/** `(uint32_t)data[i]` over a signed `char`: a high-bit byte sign-extends. */
const signedByte: ByteReader = (byte) => (byte << 24) >> 24;

const rotateLeft = (value: number, count: number): number =>
  (value << count) | (value >>> (32 - count));

const scramble = (k: number): number => Math.imul(rotateLeft(Math.imul(k, C1), R1), C2);

function blockAt(data: Uint8Array, at: number, read: ByteReader): number {
  return (
    read(data[at]!) |
    (read(data[at + 1]!) << 8) |
    (read(data[at + 2]!) << 16) |
    (read(data[at + 3]!) << 24)
  );
}

function tailOf(data: Uint8Array, from: number, read: ByteReader): number {
  let k = 0;
  for (let i = data.length - 1; i >= from; i -= 1) k ^= read(data[i]!) << ((i - from) * 8);
  return k;
}

function finalMix(hash: number): number {
  let h = hash ^ (hash >>> 16);
  h = Math.imul(h, FINAL_MULTIPLIER_1);
  h ^= h >>> 13;
  h = Math.imul(h, FINAL_MULTIPLIER_2);
  return (h ^ (h >>> 16)) >>> 0;
}

/** git's `murmur3_seeded_v1`/`murmur3_seeded_v2`, as an unsigned 32-bit value. */
export function murmur3Seeded(seed: number, data: Uint8Array, version: BloomHashVersion): number {
  const read = version === 2 ? unsignedByte : signedByte;
  const tailStart = data.length - (data.length % BLOCK_SIZE);
  let hash = seed | 0;
  for (let at = 0; at < tailStart; at += BLOCK_SIZE) {
    hash ^= scramble(blockAt(data, at, read));
    hash = (Math.imul(rotateLeft(hash, R2), M) + N) | 0;
  }
  if (tailStart < data.length) hash ^= scramble(tailOf(data, tailStart, read));
  return finalMix(hash ^ data.length);
}

/**
 * git's `bloom_key_fill`: probe `i` is `hash0 + i * hash1`, wrapping at 32 bits.
 * Drawn on demand — `numHashes` is read unchecked from a graph's `BDAT`
 * header, as git reads it, so it must never size an allocation.
 */
export function* bloomKeyHashes(
  path: Uint8Array,
  settings: BloomFilterSettings,
): Generator<number, void, undefined> {
  const hash0 = murmur3Seeded(SEED_0, path, settings.hashVersion);
  const hash1 = murmur3Seeded(SEED_1, path, settings.hashVersion);
  for (let i = 0; i < settings.numHashes; i += 1) yield (hash0 + Math.imul(i, hash1)) >>> 0;
}

const binaryKey = (path: Uint8Array): string => {
  // Stryker disable next-line StringLiteral: equivalent — the same prefix on every key keeps two keys equal exactly when their paths are.
  let key = '';
  for (const byte of path) key += String.fromCharCode(byte);
  return key;
};

/** Each changed path and every leading directory of it, once — without the trailing `/`. */
function distinctPathsWithDirectories(changedPaths: readonly Uint8Array[]): Uint8Array[] {
  const distinct = new Map<string, Uint8Array>();
  for (const path of changedPaths) {
    distinct.set(binaryKey(path), path);
    for (let end = path.lastIndexOf(SLASH); end > 0; end = path.lastIndexOf(SLASH, end - 1)) {
      const directory = path.subarray(0, end);
      distinct.set(binaryKey(directory), directory);
    }
  }
  return [...distinct.values()];
}

function addKey(filter: Uint8Array, hashes: Iterable<number>): void {
  const bitCount = filter.length * BITS_PER_WORD;
  for (const hash of hashes) {
    const bit = hash % bitCount;
    filter[Math.floor(bit / BITS_PER_WORD)]! |= 1 << (bit % BITS_PER_WORD);
  }
}

/**
 * git's `get_or_compute_bloom_filter` past the tree diff: `changedPaths` are
 * the first-parent diff's paths. Too many distinct paths yield the one-byte
 * `0xFF` marker; none yields a single zero byte.
 */
export function changedPathFilter(
  changedPaths: readonly Uint8Array[],
  settings: BloomFilterSettings,
): Uint8Array {
  const paths = distinctPathsWithDirectories(changedPaths);
  if (paths.length > settings.maxChangedPaths) return Uint8Array.of(TOO_LARGE_FILTER);
  const length = Math.ceil((paths.length * settings.bitsPerEntry) / BITS_PER_WORD);
  const filter = new Uint8Array(Math.max(length, 1));
  for (const path of paths) addKey(filter, bloomKeyHashes(path, settings));
  return filter;
}
