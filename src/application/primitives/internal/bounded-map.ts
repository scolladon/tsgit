/**
 * Run `worker` over `items` with at most `limit` in flight, returning results in
 * INPUT ORDER. Rejection propagates (Promise.all semantics); in-flight tasks are not
 * cancelled. `items` must be a concrete array (no `undefined` holes).
 *
 * `limit` always comes from the concurrency policy (`internal/concurrency.ts`'s
 * `boundedMapFor`/`limitFor`) — no call site keeps a bare numeric bound of its own.
 */
export async function boundedMap<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  // Stryker disable next-line ArrayDeclaration: equivalent — every index [0,length) is assigned, so the pre-sized array and new Array() reach an identical dense result; length arg is a perf-only allocation hint
  const results = new Array<R>(items.length);
  let cursor = 0;
  const run = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx] as T);
    }
  };
  const concurrency = Math.min(limit, items.length);
  const runners: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) runners.push(run());
  await Promise.all(runners);
  return results;
}
