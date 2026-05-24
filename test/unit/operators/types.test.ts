import { expectTypeOf } from 'expect-type';
import { describe, expect, it } from 'vitest';
import type { Awaitable } from '../../../src/operators/types.js';

describe('Awaitable<T>', () => {
  describe('Given a value of type T', () => {
    describe('When invoked', () => {
      it('Then it is assignable to Awaitable<T>', () => {
        // Arrange + Assert (type-level)
        expectTypeOf<number>().toExtend<Awaitable<number>>();
      });
    });
  });

  describe('Given a Promise<T>', () => {
    describe('When invoked', () => {
      it('Then it is assignable to Awaitable<T>', () => {
        // Arrange + Assert (type-level)
        expectTypeOf<Promise<string>>().toExtend<Awaitable<string>>();
      });
    });
  });

  describe('Given a PromiseLike<T> with a then method', () => {
    describe('When invoked', () => {
      it('Then it is assignable to Awaitable<T>', () => {
        // Arrange + Assert (type-level) — pins the PromiseLike (not Promise) widening
        expectTypeOf<PromiseLike<boolean>>().toExtend<Awaitable<boolean>>();
      });
    });
  });

  describe('Given an unrelated object', () => {
    describe('When invoked', () => {
      it('Then TS rejects the assignment to Awaitable<T>', () => {
        // Arrange
        // @ts-expect-error — { foo: 1 } is not assignable to Awaitable<number>
        const rejected: Awaitable<number> = { foo: 1 };

        // Assert — the @ts-expect-error compile-time check is the real
        // assertion; this runtime check pins that the assignment kept the
        // object's runtime shape (also satisfies the assertion-count rule).
        expect(rejected).toEqual({ foo: 1 });
      });
    });
  });
});
