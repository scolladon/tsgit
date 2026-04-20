import type { Awaitable } from './types.js';

export function map<T, U>(
  mapper: (value: T) => Awaitable<U>,
): (source: AsyncIterable<T>) => AsyncIterable<U> {
  return async function* (source: AsyncIterable<T>): AsyncIterable<U> {
    for await (const value of source) {
      yield await mapper(value);
    }
  };
}
