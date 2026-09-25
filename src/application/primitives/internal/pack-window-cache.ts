/**
 * Per-registry pack window cache — git's `use_pack` shape: a bounded window
 * per pack, LRU-evicted under one registry-wide byte limit. A request fully
 * inside a window returns a `subarray` VIEW, never a copy; a request too
 * large for a window, or a budget too small to ever hold one, bypasses the
 * cache and reads directly.
 */
import { createLruCache } from '../../../domain/storage/index.js';
import type { Context } from '../../../ports/context.js';
import { readConfig } from '../config-read.js';

export const DEFAULT_PACK_WINDOW_BYTES = 64 * 1024;
export const DEFAULT_PACK_WINDOW_LIMIT_BYTES = 16 * 1024 * 1024;

// git's own page size is `getpagesize()` — 4096 on Linux, 16384 on Apple
// silicon. This cache already assumed the Linux figure for its window-base
// alignment before this normalisation existed; kept for a deterministic
// budget across dev machines rather than a real (unavailable) page-size
// probe.
const PAGE_BYTES = 4096;
// git's `pgsz_x2` (environment.c): 2× the OS page size, the unit
// `core.packedGitWindowSize` is normalised to.
const PACKED_GIT_WINDOW_UNIT = 2 * PAGE_BYTES;

/**
 * git normalises `core.packedGitWindowSize` to a whole `pgsz_x2` unit with a
 * floor of one unit (`environment.c`): `packed_git_window_size /= pgsz_x2; if
 * (packed_git_window_size < 1) packed_git_window_size = 1;
 * packed_git_window_size *= pgsz_x2;`. Below one unit rounds UP to it; at or
 * past one unit, integer division truncates the remainder DOWN into the same
 * unit — never up to the next one.
 */
function normalizePackedGitWindowSize(value: number): number {
  const units = Math.max(1, Math.floor(value / PACKED_GIT_WINDOW_UNIT));
  return units * PACKED_GIT_WINDOW_UNIT;
}

export interface PackWindowBudget {
  readonly windowBytes: number;
  readonly limitBytes: number;
}

/**
 * `core.packedGitWindowSize`/`core.packedGitLimit` can only LOWER tsgit's
 * defaults — git's own figures are mmap reservations an eager heap read
 * cannot honour. The eager config gate refuses a malformed value before any
 * read reaches here, so a present key is always a valid number. A present
 * `packedGitWindowSize` is normalised to git's own `pgsz_x2` unit BEFORE the
 * upper-bound clamp, exactly as git normalises it before ever comparing it
 * to anything else.
 */
export const packWindowBudgetFor = async (ctx: Context): Promise<PackWindowBudget> => {
  const { core } = await readConfig(ctx);
  const windowSize = core?.packedGitWindowSize;
  const normalizedWindow =
    windowSize === undefined ? DEFAULT_PACK_WINDOW_BYTES : normalizePackedGitWindowSize(windowSize);
  return {
    windowBytes: Math.min(DEFAULT_PACK_WINDOW_BYTES, normalizedWindow),
    limitBytes: Math.min(
      DEFAULT_PACK_WINDOW_LIMIT_BYTES,
      core?.packedGitLimit ?? DEFAULT_PACK_WINDOW_LIMIT_BYTES,
    ),
  };
};

/** Reads `size` bytes at `base`, clamped by the caller at the file's own
 *  end — the cache never inspects a file's real size itself. */
export type WindowLoader = (base: number, size: number) => Promise<Uint8Array>;

export interface PackWindowCache {
  readonly read: (
    packName: string,
    offset: number,
    length: number,
    load: WindowLoader,
  ) => Promise<Uint8Array>;
  readonly clear: () => void;
}

function alignedBase(offset: number, unit: number): number {
  return Math.floor(offset / unit) * unit;
}

function windowKey(packName: string, base: number): string {
  return `${packName}:${base}`;
}

/** Whether `[offset, offset + length)` lies fully within `[base, base + windowBytes)`. */
function fitsWindow(offset: number, length: number, base: number, windowBytes: number): boolean {
  return offset + length <= base + windowBytes;
}

export function createPackWindowCache({
  windowBytes,
  limitBytes,
}: PackWindowBudget): PackWindowCache {
  const windows = createLruCache<Uint8Array>(limitBytes);
  // Single-flight for a cache MISS: concurrent readers of the same key join
  // the one load already under way instead of each starting their own full
  // window read. Cleared on settle (the flight is over either way) and by
  // `clear()` (a fault or a refresh must not let a later reader join a
  // flight the cache no longer stands behind).
  const inFlightLoads = new Map<string, Promise<Uint8Array>>();
  // Bumped by every clear() — a load started before a clear() must not fill
  // `windows` for the retired epoch once it resolves after it (a stale,
  // possibly cross-generation fill masquerading as a fresh cache entry).
  let epoch = 0;

  const loadAndCache = async (
    key: string,
    base: number,
    load: WindowLoader,
    startEpoch: number,
  ): Promise<Uint8Array> => {
    const window = await load(base, windowBytes);
    // A window base past the pack's own end loads empty — the LRU rejects a
    // zero-byte entry (there is nothing to evict room for), and caching it
    // would buy nothing: the next read at the same base costs the same
    // empty load either way. `epoch === startEpoch` is the retired-fill
    // guard above.
    if (window.byteLength > 0 && epoch === startEpoch) windows.set(key, window, window.byteLength);
    return window;
  };

  const cachedWindow = (
    packName: string,
    base: number,
    load: WindowLoader,
  ): Promise<Uint8Array> => {
    const key = windowKey(packName, base);
    const cached = windows.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const existing = inFlightLoads.get(key);
    if (existing !== undefined) return existing;
    const startEpoch = epoch;
    const pending: Promise<Uint8Array> = loadAndCache(key, base, load, startEpoch).finally(() => {
      // Identity-guarded: an abandoned flight settling after a clear() (and
      // a fresh flight already installed for the same key) must not delete
      // the fresh flight's own map entry out from under it.
      if (inFlightLoads.get(key) === pending) inFlightLoads.delete(key);
    });
    inFlightLoads.set(key, pending);
    return pending;
  };

  const viewAt = (window: Uint8Array, base: number, offset: number, length: number): Uint8Array =>
    window.subarray(offset - base, offset - base + length);

  const read = async (
    packName: string,
    offset: number,
    length: number,
    load: WindowLoader,
  ): Promise<Uint8Array> => {
    if (length > windowBytes || limitBytes < windowBytes) return load(offset, length);
    const windowBase = alignedBase(offset, windowBytes);
    if (!fitsWindow(offset, length, windowBase, windowBytes)) {
      // Straddles the window-aligned boundary. A page-aligned rescue window
      // would re-load whatever byte range the FOLLOWING aligned window is
      // about to cover on the next sequential read — up to a whole window's
      // worth of double I/O over their overlap. Serving it directly, once,
      // uncached, costs only this one small request instead.
      return load(offset, length);
    }
    const window = await cachedWindow(packName, windowBase, load);
    return viewAt(window, windowBase, offset, length);
  };

  const clear = (): void => {
    // Stryker disable next-line AssignmentOperator: equivalent — `epoch` is only ever read via `===` against a snapshot taken before this call; decrementing instead of incrementing still produces a value distinct from every prior snapshot, which is the only property `loadAndCache`'s guard depends on.
    epoch += 1;
    windows.clear();
    // A reader arriving after clear() must never join a flight this cache no
    // longer stands behind — its eventual fill would write into the
    // just-cleared LRU under a key nothing here still vouches for.
    inFlightLoads.clear();
  };

  return { read, clear };
}
