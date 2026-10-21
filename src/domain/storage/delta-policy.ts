/**
 * Pure decisions for offset-delta selection: the emission-order comparator
 * and the disk-size acceptance predicate `deltify.ts`'s window drives, plus
 * the `pack.window` / `pack.depth` / `pack.windowMemory` config resolver.
 * Kept out of `delta-encode.ts` so the codec and the policy stay one
 * concern each.
 */
import type { BasePackEntryType } from './pack-entry.js';

/** The widest `encodeOfsDistance` output the reader will accept:
 *  `decodeOfsDistance` refuses more than 4 continuation bytes, so 5 bytes
 *  total. */
export const MAX_OFS_OVERHEAD_BYTES = 5;
export const DEFAULT_PACK_WINDOW = 10;
export const DEFAULT_PACK_DEPTH = 50;
/** git pack-objects' own ceiling: a `pack.depth` above it is forced to it. */
const MAX_PACK_DEPTH = 4095;

/** A recency-absent object: every such object ties on this term and falls
 *  to `id`. */
export const NO_RECENCY = 0;

export interface PackEmissionKey {
  readonly id: string;
  /** typeRank IS the pack entry type numbering (1..4) */
  readonly type: BasePackEntryType;
  /** uint32; 0 for a path-less object. */
  readonly nameHash: number;
  readonly uncompressedSize: number;
  /** Caller-supplied first-seen ordinal, or `NO_RECENCY` when the caller
   *  passed none. */
  readonly recency: number;
}

/**
 * Total order: (type ASC, nameHash DESC, uncompressedSize DESC, recency ASC,
 * id ASC). No two distinct objects compare equal, because oids are unique.
 * In the recency-absent mode — every key at `NO_RECENCY` — the order is a
 * pure function of each object's own values, which is what makes the sort
 * stable regardless of the input array's order; a caller-supplied recency
 * adds first-seen order as a further, still deterministic, input.
 */
export function comparePackEmissionOrder(a: PackEmissionKey, b: PackEmissionKey): number {
  if (a.type !== b.type) return a.type - b.type;
  if (a.nameHash !== b.nameHash) return b.nameHash - a.nameHash;
  if (a.uncompressedSize !== b.uncompressedSize) return b.uncompressedSize - a.uncompressedSize;
  if (a.recency !== b.recency) return a.recency - b.recency;
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
  /** `core.bigFileThreshold`: an object strictly above it is neither a delta
   *  target nor a base, as git marks it `no_try_delta`. */
  readonly bigFileThreshold: number;
}

/** git's own `should_attempt_deltas`: an object this small is neither
 *  offered as a delta target nor admitted to the window as a prospective
 *  base — a delta's own header and instruction overhead can never pay for
 *  itself against something this small. */
export const DELTA_FLOOR_BYTES = 50;

/** Whether an object of `size` bytes takes part in the delta search, as a
 *  target and as a base alike. */
export function attemptsDelta(policy: DeltaPolicy, size: number): boolean {
  return size >= DELTA_FLOOR_BYTES && size <= policy.bigFileThreshold;
}

/**
 * Resolves `pack.window` / `pack.depth` / `pack.windowMemory` into the
 * selection policy. `window` or `depth` at `0` or `-1` disables delta
 * emission entirely — git's own switch, not a tsgit escape hatch. There is
 * no clamp-to-1: clamping a legal `0` up to `1` would silently re-enable a
 * feature the caller turned off. `depth` above git's 4095 ceiling is clamped
 * to it, silently, as git does.
 */
export function resolveDeltaPolicy(
  config: {
    readonly window?: number;
    readonly depth?: number;
    readonly windowMemory?: number;
  },
  bigFileThreshold: number,
): DeltaPolicy {
  const window = config.window ?? DEFAULT_PACK_WINDOW;
  const depth = config.depth ?? DEFAULT_PACK_DEPTH;
  return {
    enabled: window > 0 && depth > 0,
    window,
    maxDepth: Math.min(depth, MAX_PACK_DEPTH),
    windowMemoryBudget: config.windowMemory ?? 0,
    bigFileThreshold,
  };
}
