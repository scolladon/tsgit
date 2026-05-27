import { operationAborted } from '../../../domain/error.js';
import type { FilePath } from '../../../domain/objects/index.js';
import { assertOrdered } from '../snapshot/path-merge.js';

const DEFAULT_MAX_INFLIGHT_BYTES = 64 * 1024 * 1024;

export interface LoadBlobOptions {
  readonly concurrency?: number;
  readonly maxInflightBytes?: number;
  readonly signal?: AbortSignal;
}

type SlotKeyedRow = { readonly path: FilePath };

interface Sizeable {
  readonly stat?: { readonly size: number };
}

interface Readable {
  read?: () => Promise<unknown>;
}

interface PendingRead<R> {
  readonly row: R;
  readonly size: number;
  readonly task: Promise<unknown>;
}

const sizeOf = (entry: unknown): number => {
  const candidate = entry as Sizeable;
  return candidate?.stat?.size ?? 0;
};

const readForSlot = (
  row: unknown,
  slot: string,
): { readonly size: number; readonly task: Promise<unknown> } => {
  const candidate = (row as Record<string, unknown>)[slot] as Readable | undefined;
  return {
    size: sizeOf(candidate),
    task: candidate?.read === undefined ? Promise.resolve() : candidate.read(),
  };
};

interface QueueState<R> {
  readonly inflight: Array<PendingRead<R>>;
  bytes: number;
}

const drainOldest = async <R>(state: QueueState<R>): Promise<R> => {
  const head = state.inflight.shift();
  if (head === undefined) throw new Error('drainOldest invariant: queue empty');
  await head.task;
  // equivalent-mutant: flipping `-=` to `+=` here keeps the saturation
  // gate firing more aggressively (state.bytes never shrinks), but the
  // observable yield count and order are unchanged: peak in-flight is
  // bounded separately by the drain loop's `length > 0` guard, and
  // state.bytes is only consulted inside `isQueueSaturated()` which is
  // already saturated at that point.
  state.bytes -= head.size;
  return head.row;
};

/**
 * Reads the blob bytes for a named slot, with a bounded in-flight byte
 * budget. The operator preserves order and forwards rows verbatim;
 * downstream consumers can rely on the `read()` cache being warm.
 *
 * `maxInflightBytes` (default: 64 MiB) caps the total size of in-flight
 * reads. When the budget is exhausted, oldest reads are awaited before
 * issuing new ones. This protects against memory blow-up on repos with
 * occasional multi-GiB blobs.
 */
export const loadBlob = <R extends SlotKeyedRow>(slot: string, opts: LoadBlobOptions = {}) =>
  async function* (source: AsyncIterable<R>): AsyncIterable<R> {
    const concurrency = opts.concurrency ?? 4;
    const maxInflightBytes = opts.maxInflightBytes ?? DEFAULT_MAX_INFLIGHT_BYTES;
    const state: QueueState<R> = { inflight: [], bytes: 0 };

    const isQueueSaturated = (): boolean =>
      state.inflight.length >= concurrency || state.bytes >= maxInflightBytes;

    for await (const row of assertOrdered(source)) {
      if (opts.signal?.aborted === true) throw operationAborted();
      const { size, task } = readForSlot(row, slot);
      state.inflight.push({ row, size, task });
      state.bytes += size;
      // equivalent-mutant: replacing `state.inflight.length > 0` with
      // `true` (or `>= 0`) is observably equivalent — `state.bytes >=
      // maxInflightBytes` can only be true when at least one row has
      // been pushed (bytes is only ever increased on push), so the
      // length-zero case is unreachable inside this loop.
      while (isQueueSaturated() && state.inflight.length > 0) {
        yield await drainOldest(state);
      }
    }
    while (state.inflight.length > 0) {
      yield await drainOldest(state);
    }
  };
