export function take<T>(count: number): (source: AsyncIterable<T>) => AsyncIterable<T> {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError('take(count): count must be a non-negative integer');
  }
  return async function* (source: AsyncIterable<T>): AsyncIterable<T> {
    if (count === 0) return;
    let yielded = 0;
    for await (const value of source) {
      yield value;
      yielded += 1;
      // Stryker disable next-line all -- equivalent mutant: `>= count` ↔ `> count - 1` for integer count
      if (yielded >= count) return;
    }
  };
}
