import type { FilePath } from '../../../domain/objects/object-id.js';
import type { Context } from '../../../ports/context.js';

/**
 * git cleans one path at a time, in index order. A command that reads the
 * work tree concurrently enlists its paths in that order; a path's clean is
 * then admitted only once every path enlisted before it has been released —
 * cleaned, or done without a clean.
 */
export interface CleanOrder {
  /** Appends `path` to the order; a path already enlisted keeps its place. */
  enlist(path: FilePath): void;
  /** Marks `path` done, so the paths after it may clean; idempotent. */
  release(path: FilePath): void;
  /** 'write' span: `path` failed — every later waiter and later admitWrite rejects with `error`. */
  halt(path: FilePath, error: unknown): void;
}

/**
 * What the order sequences: 'clean' gates the filter run only; 'write' gates
 * conversion and the object write too, the turn held until `release`.
 */
export type OrderSpan = 'clean' | 'write';

interface Sequence extends CleanOrder {
  readonly span: OrderSpan;
  admit(path: FilePath): Promise<void>;
}

const ADMITTED: Promise<void> = Promise.resolve();

const UNORDERED: CleanOrder = {
  enlist: () => undefined,
  release: () => undefined,
  halt: () => undefined,
};

/** Keyed on the Context object itself, as the filter-process pool is. */
const sequences = new WeakMap<Context, Sequence>();

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/** The earliest halted path's ordinal and the error every path after it meets. */
interface Halt {
  readonly ordinal: number;
  readonly error: unknown;
}

/** Every enlisted path's ordinal, which have been released, and who waits on which. */
interface SequenceState {
  readonly ordinals: Map<FilePath, number>;
  readonly released: boolean[];
  readonly waiters: Map<number, Waiter>;
  /** The lowest ordinal not yet released: the one path free to clean. */
  next: number;
  halted?: Halt;
}

const createSequence = (span: OrderSpan): Sequence => {
  const state: SequenceState = { ordinals: new Map(), released: [], waiters: new Map(), next: 0 };
  return {
    span,
    enlist: (path) => enlistIn(state, path),
    release: (path) => releaseIn(state, path),
    halt: (path, error) => haltIn(state, path, error),
    admit: (path) => admitIn(state, path),
  };
};

const enlistIn = (state: SequenceState, path: FilePath): void => {
  if (state.ordinals.has(path)) return;
  state.ordinals.set(path, state.released.length);
  state.released.push(false);
};

const releaseIn = (state: SequenceState, path: FilePath): void => {
  const ordinal = state.ordinals.get(path);
  if (ordinal === undefined) return;
  state.released[ordinal] = true;
  advance(state);
};

const advance = (state: SequenceState): void => {
  while (state.released[state.next] === true) state.next += 1;
  state.waiters.get(state.next)?.resolve();
};

const haltIn = (state: SequenceState, path: FilePath, error: unknown): void => {
  const ordinal = state.ordinals.get(path);
  if (ordinal === undefined) return;
  if (state.halted !== undefined && state.halted.ordinal <= ordinal) return;
  state.halted = { ordinal, error };
  for (const [waiting, waiter] of state.waiters) {
    if (waiting > ordinal) waiter.reject(error);
  }
};

const admitIn = (state: SequenceState, path: FilePath): Promise<void> => {
  const ordinal = state.ordinals.get(path);
  if (ordinal === undefined) return ADMITTED;
  if (state.halted !== undefined && ordinal > state.halted.ordinal) {
    return Promise.reject(state.halted.error);
  }
  if (ordinal <= state.next) return ADMITTED;
  return new Promise((resolve, reject) => state.waiters.set(ordinal, { resolve, reject }));
};

/**
 * Runs `body` with a clean order open on `ctx`. A scope opened while another
 * is open on the same Context leaves the outer one in charge: its own
 * enlistments are no-ops, so its paths clean unordered rather than tangle
 * with the outer order.
 */
export const withCleanOrder = async <T>(
  ctx: Context,
  body: (order: CleanOrder) => Promise<T>,
  span: OrderSpan = 'clean',
): Promise<T> => {
  if (sequences.has(ctx)) return body(UNORDERED);
  const sequence = createSequence(span);
  sequences.set(ctx, sequence);
  try {
    return await body(sequence);
  } finally {
    sequences.delete(ctx);
  }
};

/**
 * Resolves once `path` may clean: at once when no order is open or `path` is
 * not in it. A 'write' span admitted the path at `admitWrite` already.
 */
export const admitClean = (ctx: Context, path: FilePath): Promise<void> => {
  const sequence = sequences.get(ctx);
  return sequence === undefined || sequence.span === 'write' ? ADMITTED : sequence.admit(path);
};

/** Resolves once `path` may convert and write: at once unless a 'write' span is open; rejects once it halted. */
export const admitWrite = (ctx: Context, path: FilePath): Promise<void> => {
  const sequence = sequences.get(ctx);
  return sequence?.span === 'write' ? sequence.admit(path) : ADMITTED;
};

/** Releases `path` in the order open on `ctx`; a 'write' span keeps the turn until the blob is written. */
export const releaseClean = (ctx: Context, path: FilePath): void => {
  const sequence = sequences.get(ctx);
  if (sequence?.span === 'clean') sequence.release(path);
};
