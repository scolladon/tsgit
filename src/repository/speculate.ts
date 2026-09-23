/**
 * Turns a promise into a value the caller can decide NOT to look at, without
 * ever leaving a handler-less rejection behind: `speculate` attaches its
 * `.then` in the same synchronous step the promise is started, so firing off
 * several probes before awaiting any of them (`find-layout.ts`,
 * `trust-verdict.ts`) never trips an unhandled-rejection warning on the ones
 * a decision turns out not to need.
 *
 * @internal — a collaborator of the open-time batched probes, not part of
 * the published type surface.
 */
export type Speculated<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

export const speculate = <T>(promise: Promise<T>): Promise<Speculated<T>> =>
  promise.then(
    (value): Speculated<T> => ({ ok: true, value }),
    (error: unknown): Speculated<T> => ({ ok: false, error }),
  );

/**
 * Reads a speculation the decision DOES need: the original rejection is
 * rethrown untouched (`rejects.toBe(err)`), matching what awaiting the
 * un-speculated promise directly would have done.
 */
export const settleSpeculation = async <T>(speculation: Promise<Speculated<T>>): Promise<T> => {
  const settled = await speculation;
  if (!settled.ok) throw settled.error;
  return settled.value;
};
