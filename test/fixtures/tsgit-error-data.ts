/**
 * Assertion helpers shared by the suites that pin `TsgitError` refusals:
 * `captureError` returns what an operation threw, and `dataFor` narrows a
 * thrown `TsgitError`'s data to the variant carrying the expected code.
 */
import { expect } from 'vitest';

import { TsgitError } from '../../src/domain/index.js';

/** Runs `op`, returning the thrown value (or `undefined` if it didn't throw). */
export async function captureError(op: () => Promise<unknown>): Promise<unknown> {
  try {
    await op();
    return undefined;
  } catch (err) {
    return err;
  }
}

/** Asserts `err` is a `TsgitError` carrying `code`, and returns its data narrowed to that variant. */
export function dataFor<Code extends TsgitError['data']['code']>(
  err: unknown,
  code: Code,
): Extract<TsgitError['data'], { code: Code }> {
  expect(err).toBeInstanceOf(TsgitError);
  const { data } = err as TsgitError;
  expect(data.code).toBe(code);
  return data as Extract<TsgitError['data'], { code: Code }>;
}
