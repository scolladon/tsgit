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

const createSequence = (): Sequence => {
  const ordinals = new Map<FilePath, number>();
  const released: boolean[] = [];
  const waiters = new Map<number, () => void>();
  // The lowest ordinal not yet released: the one path free to clean.
  let next = 0;
  const advance = (): void => {
    while (released[next] === true) next += 1;
    waiters.get(next)?.();
  };
  return {
    enlist: (path) => {
      if (ordinals.has(path)) return;
      ordinals.set(path, released.length);
      released.push(false);
    },
    release: (path) => {
      const ordinal = ordinals.get(path);
      if (ordinal === undefined) return;
      released[ordinal] = true;
      advance();
    },
    admit: (path) => {
      const ordinal = ordinals.get(path);
      if (ordinal === undefined || ordinal <= next) return ADMITTED;
      return new Promise((resolve) => waiters.set(ordinal, resolve));
    },
  };
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
