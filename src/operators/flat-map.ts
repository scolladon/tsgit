type FlatMapReturn<U> = Iterable<U> | AsyncIterable<U> | Promise<Iterable<U> | AsyncIterable<U>>;

export function flatMap<T, U>(
  mapper: (value: T) => FlatMapReturn<U>,
): (source: AsyncIterable<T>) => AsyncIterable<U> {
  return async function* (source: AsyncIterable<T>): AsyncIterable<U> {
    for await (const value of source) {
      const inner = await mapper(value);
      for await (const item of inner) {
        yield item;
      }
    }
  };
}
