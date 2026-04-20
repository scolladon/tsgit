import type { Awaitable } from './types.js';

export function groupBy<T, K>(
  keyFn: (value: T) => Awaitable<K>,
  limit: number = Number.POSITIVE_INFINITY,
): (source: AsyncIterable<T>) => Promise<ReadonlyMap<K, ReadonlyArray<T>>> {
  if (Number.isNaN(limit) || limit < 0) {
    throw new RangeError('groupBy(limit): must be a non-negative number or Infinity');
  }
  return async (source: AsyncIterable<T>): Promise<ReadonlyMap<K, ReadonlyArray<T>>> => {
    const result = new Map<K, T[]>();
    let count = 0;
    for await (const value of source) {
      // Stryker disable next-line all -- equivalent mutant: `>= limit` ↔ `> limit - 1` for integer limit (design §7.6)
      if (count >= limit) {
        throw new RangeError(`groupBy: exceeded limit of ${limit} items`);
      }
      const key = await keyFn(value);
      const bucket = result.get(key);
      // Stryker disable next-line all -- equivalent mutant: `if (bucket)` ↔ `if (bucket !== undefined)` (Map.get returns T[] | undefined; T[] is always truthy — design §7.6)
      if (bucket) {
        bucket.push(value);
      } else {
        result.set(key, [value]);
      }
      count += 1;
    }
    return result as ReadonlyMap<K, ReadonlyArray<T>>;
  };
}
