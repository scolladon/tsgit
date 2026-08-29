/// <reference lib="dom" />
import type { MachineFacts } from '../../domain/concurrency/derive-limits.js';

/** Fallback core count when `navigator.hardwareConcurrency` is absent. */
const DEFAULT_CORES = 4;

/**
 * Reads this browser's machine facts. `navigator.hardwareConcurrency` is the
 * only signal — several browsers clamp it for privacy (a hint, not a
 * measurement) — and defaults to 4 when absent. Streams are native in the
 * browser: there is no libuv threadpool to report a separate width for, so
 * `threadpoolWidth` mirrors `cores`.
 */
export function nativeMachineFacts(): MachineFacts {
  const cores = navigator.hardwareConcurrency ?? DEFAULT_CORES;
  return { cores, threadpoolWidth: cores };
}
