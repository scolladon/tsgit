/**
 * Pure decisions for offset-delta selection: the emission-order comparator
 * and the disk-size acceptance predicate `deltify.ts`'s window drives, plus
 * the `pack.window` / `pack.depth` / `pack.windowMemory` config resolver.
 * Kept out of `delta-encode.ts` so the codec and the policy stay one
 * concern each.
 */
import { MAX_DELTA_CHAIN_DEPTH } from './delta.js';
import type { BasePackEntryType } from './pack-entry.js';

/** A delta is accepted only when it beats the base entry by more than this
 *  many bytes of `OFS_DELTA` back-pointer overhead the base entry never
 *  pays — see `acceptsDeltaEntry`. */
export const DELTA_ACCEPT_RATIO = 0.5;
/** The widest `encodeOfsDistance` output the reader will accept:
 *  `decodeOfsDistance` refuses more than 4 continuation bytes, so 5 bytes
 *  total. */
export const MAX_OFS_OVERHEAD_BYTES = 5;
export const DEFAULT_PACK_WINDOW = 10;
export const DEFAULT_PACK_DEPTH = 50;

export interface PackEmissionKey {
  readonly id: string;
  /** typeRank IS the pack entry type numbering (1..4) */
  readonly type: BasePackEntryType;
  readonly uncompressedSize: number;
}

/**
 * Total order: (type ASC, uncompressedSize DESC, id ASC). No two distinct
 * objects compare equal, because oids are unique — which is what makes the
 * sort stable regardless of the input array's order.
 */
export function comparePackEmissionOrder(a: PackEmissionKey, b: PackEmissionKey): number {
  if (a.type !== b.type) return a.type - b.type;
  if (a.uncompressedSize !== b.uncompressedSize) return b.uncompressedSize - a.uncompressedSize;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** A delta is stored only when it is strictly smaller on disk, header
 *  overhead included. Ties go to the base. */
export function acceptsDeltaEntry(
  deflatedDeltaLength: number,
  deflatedContentLength: number,
): boolean {
  return deflatedDeltaLength + MAX_OFS_OVERHEAD_BYTES < deflatedContentLength;
}

export interface DeltaPolicy {
  readonly enabled: boolean;
  readonly window: number;
  readonly maxDepth: number;
  /** 0 = unlimited, matching git's `pack.windowMemory` unset/0. */
  readonly windowMemoryBudget: number;
}

/**
 * Resolves `pack.window` / `pack.depth` / `pack.windowMemory` into the
 * selection policy. `window` or `depth` at `0` or `-1` disables delta
 * emission entirely — git's own switch, not a tsgit escape hatch. There is
 * no clamp-to-1: clamping a legal `0` up to `1` would silently re-enable a
 * feature the caller turned off.
 */
export function resolveDeltaPolicy(config: {
  readonly window?: number;
  readonly depth?: number;
  readonly windowMemory?: number;
}): DeltaPolicy {
  const window = config.window ?? DEFAULT_PACK_WINDOW;
  const depth = config.depth ?? DEFAULT_PACK_DEPTH;
  return {
    enabled: window > 0 && depth > 0,
    window,
    maxDepth: Math.min(depth, MAX_DELTA_CHAIN_DEPTH),
    windowMemoryBudget: config.windowMemory ?? 0,
  };
}
