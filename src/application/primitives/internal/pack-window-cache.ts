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
const PAGE_BYTES = 4096;

export interface PackWindowBudget {
  readonly windowBytes: number;
  readonly limitBytes: number;
}

/**
 * `core.packedGitWindowSize`/`core.packedGitLimit` can only LOWER tsgit's
 * defaults — git's own figures are mmap reservations an eager heap read
 * cannot honour. The eager config gate refuses a malformed value before any
 * read reaches here, so a present key is always a valid number.
 */
export const packWindowBudgetFor = async (ctx: Context): Promise<PackWindowBudget> => {
  const { core } = await readConfig(ctx);
  return {
    windowBytes: Math.min(
      DEFAULT_PACK_WINDOW_BYTES,
      core?.packedGitWindowSize ?? DEFAULT_PACK_WINDOW_BYTES,
    ),
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

  const cachedWindow = async (
    packName: string,
    base: number,
    load: WindowLoader,
  ): Promise<Uint8Array> => {
    const key = windowKey(packName, base);
    const cached = windows.get(key);
    if (cached !== undefined) return cached;
    const window = await load(base, windowBytes);
    // A window base past the pack's own end loads empty — the LRU rejects a
    // zero-byte entry (there is nothing to evict room for), and caching it
    // would buy nothing: the next read at the same base costs the same
    // empty load either way.
    if (window.byteLength > 0) windows.set(key, window, window.byteLength);
    return window;
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
    if (fitsWindow(offset, length, windowBase, windowBytes)) {
      const window = await cachedWindow(packName, windowBase, load);
      return viewAt(window, windowBase, offset, length);
    }
    const pageBase = alignedBase(offset, PAGE_BYTES);
    if (!fitsWindow(offset, length, pageBase, windowBytes)) return load(offset, length);
    const window = await cachedWindow(packName, pageBase, load);
    return viewAt(window, pageBase, offset, length);
  };

  return { read, clear: windows.clear };
}
