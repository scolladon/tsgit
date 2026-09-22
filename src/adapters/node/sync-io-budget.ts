/**
 * Per-turn synchronous I/O budget: caps how long a burst of `*Sync` calls
 * may run before the caller must yield back to the event loop.
 *
 * `admit()` returns `undefined` while the budget still has room — no
 * microtask hop on the hot path. Once spent, every concurrent caller
 * shares one pending promise that resolves the next time the event loop
 * gets a turn, so a burst yields once, together, rather than once per
 * caller.
 *
 * @internal — not re-exported from `src/adapters/node/index.ts`.
 */

import { realSyncFsOps, type SyncFsOperations } from './fs-operations.js';

/** Clock time budgeted per event-loop turn before sync callers must yield. */
const SYNC_TURN_BUDGET_MS = 1;
/** Reads at or under this size stay on the sync fast path; larger reads defer to the threadpool. */
const MAX_SYNC_READ_BYTES = 64 * 1024;

export interface TurnBudget {
  /** `undefined` → run now; a `Promise` → await it (the next turn) before running. */
  readonly admit: () => Promise<void> | undefined;
  /** Charge the elapsed time of one completed sync operation. */
  readonly charge: (startedAt: number) => void;
  /** The budget's own clock, so callers time their own operations consistently. */
  readonly now: () => number;
}

export interface SyncIoPolicy {
  readonly ops: SyncFsOperations;
  readonly budget: TurnBudget;
  readonly maxSyncReadBytes: number;
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

const createDeferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

export const createTurnBudget = (
  budgetMs: number,
  clock: () => number = performance.now.bind(performance),
  scheduleTurnEnd: (onTurnEnd: () => void) => void = setImmediate,
): TurnBudget => {
  let spent = 0;
  let armed = false;
  let pending: Deferred | undefined;

  const onTurnEnd = (): void => {
    spent = 0;
    armed = false;
    const toResolve = pending;
    pending = undefined;
    toResolve?.resolve();
  };

  const armMarker = (): void => {
    if (armed) return;
    armed = true;
    scheduleTurnEnd(onTurnEnd);
  };

  const admit = (): Promise<void> | undefined => {
    if (spent < budgetMs) return undefined;
    armMarker();
    pending ??= createDeferred();
    return pending.promise;
  };

  const charge = (startedAt: number): void => {
    spent += clock() - startedAt;
    armMarker();
  };

  return { admit, charge, now: () => clock() };
};

export const createSyncIoPolicy = (): SyncIoPolicy => ({
  ops: realSyncFsOps,
  budget: createTurnBudget(SYNC_TURN_BUDGET_MS),
  maxSyncReadBytes: MAX_SYNC_READ_BYTES,
});

export const runWithinBudget = async <T>(budget: TurnBudget, op: () => T): Promise<T> => {
  const wait = budget.admit();
  if (wait !== undefined) await wait;
  const startedAt = budget.now();
  try {
    return op();
  } finally {
    budget.charge(startedAt);
  }
};
