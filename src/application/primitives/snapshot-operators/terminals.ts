import { operationAborted } from '../../../domain/error.js';

export interface TerminalOptions {
  readonly signal?: AbortSignal;
}

export const count = async <T>(
  source: AsyncIterable<T>,
  opts: TerminalOptions = {},
): Promise<number> => {
  let total = 0;
  for await (const _row of source) {
    if (opts.signal?.aborted === true) throw operationAborted();
    total += 1;
  }
  return total;
};

export const toArray = async <T>(
  source: AsyncIterable<T>,
  opts: TerminalOptions = {},
): Promise<ReadonlyArray<T>> => {
  const out: T[] = [];
  for await (const row of source) {
    if (opts.signal?.aborted === true) throw operationAborted();
    out.push(row);
  }
  return out;
};

export const first = async <T>(
  source: AsyncIterable<T>,
  opts: TerminalOptions = {},
): Promise<T | null> => {
  const iter = source[Symbol.asyncIterator]();
  try {
    const next = await iter.next();
    if (opts.signal?.aborted === true) throw operationAborted();
    return next.done === true ? null : next.value;
  } finally {
    if (typeof iter.return === 'function') {
      await iter.return();
    }
  }
};
