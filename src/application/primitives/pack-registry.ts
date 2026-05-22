/**
 * Lazy scan + cache of .idx files under .git/objects/pack/.
 * Returns a PackRegistry facade used by object-resolver and readObject.
 */
import type { ObjectId } from '../../domain/objects/index.js';
import { invalidPackIndex } from '../../domain/storage/error.js';
import { lookupPackIndex, type PackIndex, parsePackIndex } from '../../domain/storage/index.js';
import type { Context } from '../../ports/context.js';
import { packsDir } from './path-layout.js';
import { exceedsMaxPackIdxBytes, REASON_PACK_IDX_EXCEEDS_MAX } from './validators.js';

export interface RegisteredPack {
  readonly name: string;
  readonly index: PackIndex;
  readonly packPath: string;
  readonly idxPath: string;
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
  return { name, index, packPath: `${dir}/${name}.pack`, idxPath };
}

export function createPackRegistry(ctx: Context): PackRegistry {
  let cache: ReadonlyArray<RegisteredPack> | undefined;

  async function loadAll(): Promise<ReadonlyArray<RegisteredPack>> {
    if (cache !== undefined) return cache;
    const dir = packsDir(ctx.layout.gitDir);
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
