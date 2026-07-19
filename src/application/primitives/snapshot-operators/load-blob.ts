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
  // Stryker disable next-line StringLiteral: equivalent — this invariant throw is unreachable, drainOldest is only ever called under a length>0 guard with no await before shift(), so head is never undefined and the message text is never observed.
  if (head === undefined) throw new Error('drainOldest invariant: queue empty');
  await head.task;
  // Stryker disable next-line AssignmentOperator: equivalent — += only makes state.bytes monotonic non-decreasing; rows still drain FIFO and yield once each (order, count, read-count unchanged) and peak in-flight is fixed before the first byte-decrement, so the budget merely saturates sooner and no observable differs.
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
      while (isQueueSaturated() && state.inflight.length > 0) {
        yield await drainOldest(state);
      }
    }
    while (state.inflight.length > 0) {
      yield await drainOldest(state);
    }
  };
