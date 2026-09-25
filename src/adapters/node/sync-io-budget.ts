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

import { invalidOption } from '../../domain/commands/error.js';
import { realSyncFsOps, type SyncFsOperations } from './fs-operations.js';

/** Clock time budgeted per event-loop turn before sync callers must yield. */
const SYNC_TURN_BUDGET_MS = 1;
/** Reads at or under this size stay on the sync fast path; larger reads defer to the threadpool. */
const MAX_SYNC_READ_BYTES = 64 * 1024;

export interface TurnBudget {
  /** `undefined` → run now; a `Promise` → await it (the next turn) before running. */
  readonly admit: () => Promise<void> | undefined;
  /** Pin the turn's start at this operation's start time, on the turn's first charge. */
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
  let turnStartedAt: number | undefined;
  let armed = false;
  let pending: Deferred | undefined;

  const onTurnEnd = (): void => {
    turnStartedAt = undefined;
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
    if (turnStartedAt === undefined) return undefined;
    if (clock() - turnStartedAt < budgetMs) return undefined;
    // Stryker disable next-line CallExpression: equivalent — reaching here requires `turnStartedAt` defined, which only `charge` sets, and `charge` always arms the marker in that same call first, so `armed` is already `true` here — this call is always a no-op.
    armMarker();
    pending ??= createDeferred();
    return pending.promise;
  };

  const charge = (startedAt: number): void => {
    turnStartedAt ??= startedAt;
    armMarker();
  };

  return { admit, charge, now: () => clock() };
};

export const createSyncIoPolicy = (): SyncIoPolicy => ({
  ops: realSyncFsOps,
  budget: createTurnBudget(SYNC_TURN_BUDGET_MS),
  maxSyncReadBytes: MAX_SYNC_READ_BYTES,
});

/**
 * Resolves the public `io` option to a policy: absent or `'sync-fast-path'`
 * builds a fresh policy; `'threadpool'` opts out entirely (`undefined`, so
 * every caller runs today's async path); any other runtime value is refused
 * before any I/O happens.
 */
export const syncIoPolicyFor = (
  io: 'sync-fast-path' | 'threadpool' | undefined,
): SyncIoPolicy | undefined => {
  if (io === undefined || io === 'sync-fast-path') return createSyncIoPolicy();
  if (io === 'threadpool') return undefined;
  throw invalidOption('io', "must be 'sync-fast-path' or 'threadpool'");
};

export const runWithinBudget = async <T>(budget: TurnBudget, op: () => T): Promise<T> => {
  // A loop, not a single check: every waiter shares one pending promise
  // while the budget is spent, so a resumed caller must re-admit before
  // running — otherwise the whole fan-out barrels through in one turn the
  // instant the first waiter's `charge` starts a fresh one.
  for (let wait = budget.admit(); wait !== undefined; wait = budget.admit()) {
    await wait;
  }
  const startedAt = budget.now();
  try {
    return op();
  } finally {
    budget.charge(startedAt);
  }
};
