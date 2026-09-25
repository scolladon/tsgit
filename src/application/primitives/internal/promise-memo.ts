/**
 * Single-flight memo for an async initializer that crosses an `await`. The
 * in-progress promise — not its eventual result — is the memoised value, so
 * every caller that arrives while the flight is pending joins it instead of
 * starting a second one; a rejection clears the memo so the next `get()`
 * retries from scratch instead of caching a failure forever. If the
 * initialization owns a disposable, `dispose`/`refresh` on the caller side
 * must capture and await the pending promise before releasing it; a slot
 * clearable by anything other than the initializer needs an identity-guarded
 * clear, or a predecessor's rejection can erase a successor already in
 * flight.
 */
export interface PromiseMemo<T> {
  /** Join the in-flight initialization, or start one. */
  readonly get: () => Promise<T>;
  /** The memoised promise, or undefined when idle. Never starts one. */
  readonly peek: () => Promise<T> | undefined;
  /**
   * The already-resolved value, or undefined when idle, still in flight, or
   * the last attempt rejected. Never starts a flight — a caller that must
   * not force one falls back to its own unmemoised path while this is
   * undefined.
   */
  readonly peekSettled: () => T | undefined;
  /** Drop the memo, returning what it held (undefined when idle). */
  readonly clear: () => Promise<T> | undefined;
}

export function createPromiseMemo<T>(factory: () => Promise<T>): PromiseMemo<T> {
  let slot: Promise<T> | undefined;
  let settled: T | undefined;

  const get = (): Promise<T> => {
    if (slot !== undefined) return slot;
    const pending: Promise<T> = factory().then(
      (value) => {
        // Identity-guarded, mirroring the reject arm below: a flight `clear()`
        // already abandoned must never store its late value into a slot that
        // is now idle or already holds a successor's own flight.
        if (slot === pending) settled = value;
        return value;
      },
      (err: unknown) => {
        if (slot === pending) slot = undefined;
        throw err;
      },
    );
    slot = pending;
    return pending;
  };

  return {
    get,
    peek: () => slot,
    peekSettled: () => settled,
    clear: () => {
      const outgoing = slot;
      slot = undefined;
      settled = undefined;
      return outgoing;
    },
  };
}
