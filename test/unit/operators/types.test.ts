import { expectTypeOf } from 'expect-type';
import { describe, it } from 'vitest';
import type { Awaitable } from '../../../src/operators/types.js';

describe('Awaitable<T>', () => {
  it('Given a value of type T, When invoked, Then it is assignable to Awaitable<T>', () => {
    // Arrange
    // Assert (type-level)
    expectTypeOf<number>().toExtend<Awaitable<number>>();
  });

  it('Given a Promise<T>, When invoked, Then it is assignable to Awaitable<T>', () => {
    // Arrange
    // Assert (type-level)
    expectTypeOf<Promise<string>>().toExtend<Awaitable<string>>();
  });

  it('Given a PromiseLike<T> with a then method, When invoked, Then it is assignable to Awaitable<T>', () => {
    // Arrange
    // Assert (type-level) — pins the PromiseLike (not Promise) widening
    expectTypeOf<PromiseLike<boolean>>().toExtend<Awaitable<boolean>>();
  });

  it('Given an unrelated object, When invoked, Then TS rejects the assignment to Awaitable<T>', () => {
    // Arrange
    // @ts-expect-error — { foo: 1 } is not assignable to Awaitable<number>
    const _rejected: Awaitable<number> = { foo: 1 };
    void _rejected;
    // Assert
  });
});
