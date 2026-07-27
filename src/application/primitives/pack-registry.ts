/**
 * Lazy scan + cache of .idx files under .git/objects/pack/.
 * Returns a PackRegistry facade used by object-resolver and readObject.
 */
import { TsgitError } from '../../domain/error.js';
import type { ObjectId } from '../../domain/objects/index.js';
import { invalidPackIndex } from '../../domain/storage/error.js';
import {
  entryOffsets,
  lookupPackIndex,
  type PackIndex,
  parsePackIndex,
} from '../../domain/storage/index.js';
import type { Context } from '../../ports/context.js';
import type { FileHandle } from '../../ports/file-system.js';
import { commonGitDir, packsDir } from './path-layout.js';
import { exceedsMaxPackIdxBytes, REASON_PACK_IDX_EXCEEDS_MAX } from './validators.js';

function isUnsupportedOperation(err: unknown): boolean {
  return err instanceof TsgitError && err.data.code === 'UNSUPPORTED_OPERATION';
}

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
  /**
   * Read `length` bytes at `offset` via a lazily-opened, memoised persistent
   * `FileHandle` — one `open` per pack for its whole delta-chain walk, not one
   * per step. Falls back to a per-call `ctx.fs.readSlice` on adapters that
   * cannot open a handle (browser OPFS throws `UNSUPPORTED_OPERATION`).
   */
  readonly readSlice: (offset: number, length: number) => Promise<Uint8Array>;
  /** Release the persistent handle, if one was ever opened. Idempotent. */
  readonly close: () => Promise<void>;
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
  /** Close every loaded pack's persistent handle. Idempotent; a registry
   *  that never scanned the pack directory disposes without touching `fs`. */
  dispose(): Promise<void>;
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
    if (trailerStart < 0) {
      throw invalidPackIndex('pack file too small to contain a trailer');
    }
    cachedTable = { sortedOffsets, packFileSize, trailerStart };
    return cachedTable;
  };

  // Lazily-opened, memoised persistent handle for this pack's slice reads.
  // Cleared back to `undefined` whenever the open attempt is known-unsupported
  // (browser OPFS), so `close()` never has to unwind a rejected memo and every
  // `readSlice` call after that point falls back cleanly.
  let handlePromise: Promise<FileHandle> | undefined;

  const readSlice = async (offset: number, length: number): Promise<Uint8Array> => {
    if (handlePromise === undefined) {
      handlePromise = ctx.fs.openWithNoFollow(packPath, 'read');
    }
    try {
      const handle = await handlePromise;
      const buffer = new Uint8Array(length);
      const bytesRead = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    } catch (err) {
      if (!isUnsupportedOperation(err)) throw err;
      handlePromise = undefined;
      return ctx.fs.readSlice(packPath, offset, length);
    }
  };

  const close = async (): Promise<void> => {
    const pending = handlePromise;
    if (pending === undefined) return;
    handlePromise = undefined;
    const handle = await pending;
    await handle.close();
  };

  return { name, index, packPath, idxPath, offsetTable, readSlice, close };
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
  // Stryker disable next-line EqualityOperator: equivalent — bisectLeft returns rank in [0, len], so rank > len is unreachable; at rank===len sortedOffsets[len] is undefined !== any numeric offset, so the second clause fires the identical throw
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
      // The outgoing packs may hold open persistent handles; close them before
      // dropping the references or every refresh leaks one fd per touched pack.
      const outgoing = cache;
      cache = undefined;
      if (outgoing !== undefined) {
        void Promise.allSettled(outgoing.map((pack) => pack.close()));
      }
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
    async dispose(): Promise<void> {
      // A registry that never scanned the pack directory has no handles to
      // close — skip the scan entirely rather than triggering one just to
      // find nothing.
      if (cache === undefined) return;
      // Settle every close so one failing handle cannot strand the others.
      const results = await Promise.allSettled(cache.map((pack) => pack.close()));
      const failure = results.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
      );
      if (failure !== undefined) throw failure.reason;
    },
  };
}
