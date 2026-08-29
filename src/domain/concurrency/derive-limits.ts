/**
 * Concurrency bounds derive from the limiting resource, never a guessed
 * constant. On Node, async `fs`/`zlib`/`crypto` all queue on the libuv
 * threadpool — a CPU-bound pool wider than that pool only adds latency,
 * while an I/O-bound pool profits from oversubscription (queuing past the
 * pool's width keeps it saturated while earlier work blocks).
 */

/**
 * Raw facts a platform binding can report about its host. A field is
 * `undefined` when the fact is genuinely unknown on this runtime (workerd
 * has neither; a non-Node runtime may accept but not honour
 * `UV_THREADPOOL_SIZE`) — never a guessed number standing in for ignorance.
 */
export interface MachineFacts {
  readonly cores?: number;
  readonly threadpoolWidth?: number;
}

/** Resolved per-bucket concurrency bounds — see `deriveLimits`. */
export interface ConcurrencyLimits {
  readonly cpuBound: number;
  readonly ioBound: number;
}

/** Safe answer when a fact the bound needs is unknown. Workerd always takes this. */
const CPU_FLOOR = 1;
const IO_FLOOR = 4;
/** Never exceeded regardless of reported core count or threadpool width — bounds CPU-dispatch fan-out on an exotic host. */
const CPU_CAP = 32;
/** Never exceeded regardless of threadpool width — bounds file-descriptor pressure (the same rationale the constants this seam replaces already carried). */
const IO_CAP = 32;
/** A blocked `lstat`/read profits from queuing more work than the pool is wide; a queued deflate does not. */
const IO_OVERSUBSCRIBE = 8;

const clamp = (low: number, value: number, high: number): number =>
  Math.min(Math.max(value, low), high);

/**
 * `cpuBound` needs BOTH facts — `min(cores, threadpoolWidth)` cannot be
 * computed safely from either one alone, so a missing fact floors the whole
 * bound rather than assuming the missing side is unbounded.
 */
const deriveCpuBound = (facts: MachineFacts): number =>
  facts.cores === undefined || facts.threadpoolWidth === undefined
    ? CPU_FLOOR
    : clamp(CPU_FLOOR, Math.min(facts.cores, facts.threadpoolWidth), CPU_CAP);

/** `ioBound` depends only on threadpool width — `cores` plays no part in the formula. */
const deriveIoBound = (facts: MachineFacts): number =>
  facts.threadpoolWidth === undefined
    ? IO_FLOOR
    : clamp(IO_FLOOR, facts.threadpoolWidth * IO_OVERSUBSCRIBE, IO_CAP);

/**
 * Pure, total selector deriving concurrency bounds from machine facts. Never
 * reads a platform property itself; `facts` comes from a runtime-specific
 * binding (`nativeMachineFacts` and its browser counterpart).
 */
export function deriveLimits(facts: MachineFacts): ConcurrencyLimits {
  return { cpuBound: deriveCpuBound(facts), ioBound: deriveIoBound(facts) };
}
