import type { Awaitable } from './types.js';

export function find<T>(
  predicate: (value: T) => Awaitable<boolean>,
): (source: AsyncIterable<T>) => Promise<T | undefined> {
  return async (source: AsyncIterable<T>): Promise<T | undefined> => {
    for await (const value of source) {
      if (await predicate(value)) {
        return value;
      }
    }
    return undefined;
  };
}
