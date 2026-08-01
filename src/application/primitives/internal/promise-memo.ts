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
  /** Drop the memo, returning what it held (undefined when idle). */
  readonly clear: () => Promise<T> | undefined;
}

export function createPromiseMemo<T>(factory: () => Promise<T>): PromiseMemo<T> {
  let slot: Promise<T> | undefined;

  const get = (): Promise<T> => {
    if (slot !== undefined) return slot;
    const pending: Promise<T> = factory().catch((err: unknown) => {
      if (slot === pending) slot = undefined;
      throw err;
    });
    slot = pending;
    return pending;
  };

  return {
    get,
    peek: () => slot,
    clear: () => {
      const outgoing = slot;
      slot = undefined;
      return outgoing;
    },
  };
}
