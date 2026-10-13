/** Memoises the first call, so a pooled fan-out builds the value once and only if asked. */
export const lazily = <T>(build: () => Promise<T>): (() => Promise<T>) => {
  let pending: Promise<T> | undefined;
  return () => (pending ??= build());
};
