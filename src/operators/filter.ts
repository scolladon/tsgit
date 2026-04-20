import type { Awaitable } from './types.js';

export function filter<T>(
  predicate: (value: T) => Awaitable<boolean>,
): (source: AsyncIterable<T>) => AsyncIterable<T> {
  return async function* (source: AsyncIterable<T>): AsyncIterable<T> {
    for await (const value of source) {
      if (await predicate(value)) {
        yield value;
      }
    }
  };
}
