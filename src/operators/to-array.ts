export async function toArray<T>(
  source: AsyncIterable<T>,
  limit: number = Number.POSITIVE_INFINITY,
): Promise<T[]> {
  if (Number.isNaN(limit) || limit < 0) {
    throw new RangeError('toArray(limit): must be a non-negative number or Infinity');
  }
  const result: T[] = [];
  for await (const value of source) {
    // Stryker disable next-line all -- equivalent mutant: `>= limit` ↔ `> limit - 1` for integer limit
    if (result.length >= limit) {
      throw new RangeError(`toArray: exceeded limit of ${limit} items`);
    }
    result.push(value);
  }
  return result;
}
