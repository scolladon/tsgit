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
}

interface Sequence extends CleanOrder {
  admit(path: FilePath): Promise<void>;
}

const ADMITTED: Promise<void> = Promise.resolve();

const UNORDERED: CleanOrder = { enlist: () => undefined, release: () => undefined };

/** Keyed on the Context object itself, as the filter-process pool is. */
const sequences = new WeakMap<Context, Sequence>();

/** Every enlisted path's ordinal, which have been released, and who waits on which. */
interface SequenceState {
  readonly ordinals: Map<FilePath, number>;
  readonly released: boolean[];
  readonly waiters: Map<number, () => void>;
  /** The lowest ordinal not yet released: the one path free to clean. */
  next: number;
}

const createSequence = (): Sequence => {
  const state: SequenceState = { ordinals: new Map(), released: [], waiters: new Map(), next: 0 };
  return {
    enlist: (path) => enlistIn(state, path),
    release: (path) => releaseIn(state, path),
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
  state.waiters.get(state.next)?.();
};

const admitIn = (state: SequenceState, path: FilePath): Promise<void> => {
  const ordinal = state.ordinals.get(path);
  if (ordinal === undefined || ordinal <= state.next) return ADMITTED;
  return new Promise((resolve) => state.waiters.set(ordinal, resolve));
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
): Promise<T> => {
  if (sequences.has(ctx)) return body(UNORDERED);
  const sequence = createSequence();
  sequences.set(ctx, sequence);
  try {
    return await body(sequence);
  } finally {
    sequences.delete(ctx);
  }
};

/** Resolves once `path` may clean: at once when no order is open or `path` is not in it. */
export const admitClean = (ctx: Context, path: FilePath): Promise<void> =>
  sequences.get(ctx)?.admit(path) ?? ADMITTED;

/** Releases `path` in the order open on `ctx`, if any. */
export const releaseClean = (ctx: Context, path: FilePath): void => {
  sequences.get(ctx)?.release(path);
};
