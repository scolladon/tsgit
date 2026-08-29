import { availableParallelism } from 'node:os';
import type { MachineFacts } from '../../domain/concurrency/derive-limits.js';

/** libuv's own documented default threadpool width — a known fact when `UV_THREADPOOL_SIZE` is unset, not a guess. */
const DEFAULT_THREADPOOL_WIDTH = 4;

/**
 * Reads this Node process's machine facts: `os.availableParallelism()` for
 * core count, and `UV_THREADPOOL_SIZE` for the libuv threadpool width this
 * process actually queues async `fs`/`zlib`/`crypto` work onto. An unset or
 * non-numeric value resolves to libuv's own default width.
 */
export function nativeMachineFacts(): MachineFacts {
  return {
    cores: availableParallelism(),
    threadpoolWidth: Number(process.env.UV_THREADPOOL_SIZE) || DEFAULT_THREADPOOL_WIDTH,
  };
}
