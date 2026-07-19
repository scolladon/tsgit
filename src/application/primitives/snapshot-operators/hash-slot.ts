import { operationAborted } from '../../../domain/error.js';
import type { FilePath } from '../../../domain/objects/index.js';
import { assertOrdered } from '../snapshot/path-merge.js';

export interface HashSlotOptions {
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
}

type SlotKeyedRow = { readonly path: FilePath };

/**
 * Generic slot-hashing operator. For each row whose named slot has an
 * entry exposing `hash()`, invokes the method to warm the entry's
 * hash (most relevant for WorkdirEntry, where `hash()` reads the file
 * and computes the git blob hash).
 *
 * Row typing is intentionally loose (`R extends { path: FilePath }`):
 * the operator is a pure pipeline stage and does not constrain the
 * shape of slot entries beyond an optional `hash()` method. Concrete
 * join callers narrow at the type-projection boundary.
 */
export const hashSlot = <R extends SlotKeyedRow>(slot: string, opts: HashSlotOptions = {}) =>
  async function* (source: AsyncIterable<R>): AsyncIterable<R> {
    const concurrency = opts.concurrency ?? 4;
    type Pending = { readonly row: R; readonly task: Promise<unknown> };
    const inflight: Pending[] = [];

    const drainOldest = async (): Promise<R> => {
      const head = inflight.shift();
      // Stryker disable next-line StringLiteral: equivalent — throw is unreachable (drainOldest only runs with a non-empty queue, so shift() never yields undefined); the message is never evaluated.
      if (head === undefined) throw new Error('drainOldest invariant: queue empty');
      await head.task;
      return head.row;
    };

    for await (const row of assertOrdered(source)) {
      if (opts.signal?.aborted === true) throw operationAborted();
      const candidate = (row as Record<string, unknown>)[slot] as
        | { hash?: () => Promise<unknown> }
        | undefined;
      const task = candidate?.hash === undefined ? Promise.resolve() : candidate.hash();
      inflight.push({ row, task });
      if (inflight.length >= concurrency) {
        yield await drainOldest();
      }
    }
    while (inflight.length > 0) {
      yield await drainOldest();
    }
  };

/**
 * Conventional wrapper for the 95% case (slot named `workdir`).
 * See design §12.1.
 */
export const hashWorkdir = <R extends SlotKeyedRow>(
  opts: HashSlotOptions = {},
): ((source: AsyncIterable<R>) => AsyncIterable<R>) => hashSlot<R>('workdir', opts);
