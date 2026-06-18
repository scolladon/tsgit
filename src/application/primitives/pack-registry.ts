/**
 * Lazy scan + cache of .idx files under .git/objects/pack/.
 * Returns a PackRegistry facade used by object-resolver and readObject.
 */
import type { ObjectId } from '../../domain/objects/index.js';
import { invalidPackIndex } from '../../domain/storage/error.js';
import {
  entryOffsets,
  lookupPackIndex,
  type PackIndex,
  parsePackIndex,
} from '../../domain/storage/index.js';
import type { Context } from '../../ports/context.js';
import { commonGitDir, packsDir } from './path-layout.js';
import { exceedsMaxPackIdxBytes, REASON_PACK_IDX_EXCEEDS_MAX } from './validators.js';

export interface PackOffsetTable {
  readonly sortedOffsets: ReadonlyArray<number>;
  readonly packFileSize: number;
  readonly trailerStart: number;
}

export interface RegisteredPack {
  readonly name: string;
  readonly index: PackIndex;
  readonly packPath: string;
  readonly idxPath: string;
  /** Lazily-built, cached sorted entry offsets + trailer bound for this pack. */
  readonly offsetTable: () => Promise<PackOffsetTable>;
}

export interface PackLookupHit {
  readonly pack: RegisteredPack;
  readonly offset: number;
}

export interface PackRegistry {
  all(): Promise<ReadonlyArray<RegisteredPack>>;
  lookup(id: ObjectId): Promise<PackLookupHit | undefined>;
  /** Drop the cached `.idx` scan so the next `all`/`lookup` re-scans the
   *  pack directory — used after a lazy-fetch writes a new pack. */
  refresh(): void;
}

function isSafePackName(name: string): boolean {
  return !name.includes('/') && !name.includes('\\') && !name.includes('..');
}

function isCandidate(entry: { isFile: boolean; name: string }): boolean {
  return entry.isFile && entry.name.endsWith('.idx') && isSafePackName(entry.name);
}

async function readBoundedIdx(ctx: Context, idxPath: string): Promise<Uint8Array> {
  // Pre-check stat; reject .idx files large enough to exhaust heap before
  // any allocation. Mirrors the readIndex pattern.
  const stat = await ctx.fs.stat(idxPath);
  if (exceedsMaxPackIdxBytes(stat.size)) {
    throw invalidPackIndex(REASON_PACK_IDX_EXCEEDS_MAX);
  }
  const bytes = await ctx.fs.read(idxPath);
  // Post-check defends against TOCTOU growth between stat and read.
  if (exceedsMaxPackIdxBytes(bytes.length)) {
    throw invalidPackIndex(REASON_PACK_IDX_EXCEEDS_MAX);
  }
  return bytes;
}

async function loadPack(ctx: Context, dir: string, entryName: string): Promise<RegisteredPack> {
  const idxPath = `${dir}/${entryName}`;
  const idxBytes = await readBoundedIdx(ctx, idxPath);
  const index = parsePackIndex(idxBytes);
  const name = entryName.slice(0, -'.idx'.length);
  const packPath = `${dir}/${name}.pack`;

  let cachedTable: PackOffsetTable | undefined;
  const offsetTable = async (): Promise<PackOffsetTable> => {
    if (cachedTable !== undefined) return cachedTable;
    const stat = await ctx.fs.stat(packPath);
    const packFileSize = stat.size;
    const raw = entryOffsets(index);
    const sortedOffsets = [...raw].sort((a, b) => a - b);
    // The pack file trailer is a single pack-checksum digest (SHA-1: 20 bytes,
    // SHA-256: 32 bytes). The last entry's data ends exactly at trailerStart.
    const trailerStart = packFileSize - ctx.hashConfig.digestLength;
    // equivalent-mutant: `<= 0` differs only at trailerStart===0; a parseable pack has ≥ 12-byte header + digestLength trailer so packFileSize ≥ digestLength+12, trailerStart ≥ 12 > 0 is unreachable
    if (trailerStart < 0) {
      throw invalidPackIndex('pack file too small to contain a trailer');
    }
    cachedTable = { sortedOffsets, packFileSize, trailerStart };
    return cachedTable;
  };

  return { name, index, packPath, idxPath, offsetTable };
}

function bisectLeft(arr: ReadonlyArray<number>, value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((arr[mid] as number) < value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

export function nextOffsetForEntry(table: PackOffsetTable, offset: number): number {
  const { sortedOffsets, trailerStart } = table;
  const rank = bisectLeft(sortedOffsets, offset);
  // equivalent-mutant: both `rank > len` and dropping `rank >= len` are equivalent — at rank===len, sortedOffsets[len] is undefined which !== any valid offset number, so the same throw fires either way
  if (rank >= sortedOffsets.length || sortedOffsets[rank] !== offset) {
    throw invalidPackIndex('offset not in pack index: corrupt index');
  }
  if (rank === sortedOffsets.length - 1) {
    return trailerStart;
  }
  return sortedOffsets[rank + 1] as number;
}

export function createPackRegistry(ctx: Context): PackRegistry {
  let cache: ReadonlyArray<RegisteredPack> | undefined;

  async function loadAll(): Promise<ReadonlyArray<RegisteredPack>> {
    if (cache !== undefined) return cache;
    const dir = packsDir(commonGitDir(ctx));
    if (!(await ctx.fs.exists(dir))) {
      cache = [];
      return cache;
    }
    const entries = await ctx.fs.readdir(dir);
    const packs: RegisteredPack[] = [];
    for (const entry of entries) {
      if (!isCandidate(entry)) continue;
      packs.push(await loadPack(ctx, dir, entry.name));
    }
    cache = packs;
    return cache;
  }

  return {
    all: loadAll,
    refresh(): void {
      cache = undefined;
    },
    async lookup(id: ObjectId): Promise<PackLookupHit | undefined> {
      const packs = await loadAll();
      for (const pack of packs) {
        const offset = lookupPackIndex(pack.index, id);
        if (offset !== undefined) {
          return { pack, offset };
        }
      }
      return undefined;
    },
  };
}
