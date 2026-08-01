import { describe, expect, it } from 'vitest';
import { createPromiseMemo } from '../../../../../src/application/primitives/internal/promise-memo.js';
import { permissionDenied } from '../../../../../src/domain/error.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createPromiseMemo', () => {
  describe('Given an idle memo', () => {
    describe('When peek() is called', () => {
      it('Then it returns undefined and the factory never ran', () => {
        // Arrange
        let factoryRuns = 0;
        const sut = createPromiseMemo(async () => {
          factoryRuns += 1;
          return 'value';
        });

        // Act
        const result = sut.peek();

        // Assert
        expect(result).toBeUndefined();
        expect(factoryRuns).toBe(0);
      });
    });

    describe('When 8 get() calls run under Promise.all', () => {
      it('Then the factory ran exactly once and all 8 resolved values are the same object reference', async () => {
        // Arrange
        let factoryRuns = 0;
        const value = { id: 'shared' };
        const sut = createPromiseMemo(async () => {
          factoryRuns += 1;
          return value;
        });

        // Act
        const results = await Promise.all(Array.from({ length: 8 }, () => sut.get()));

        // Assert
        expect(factoryRuns).toBe(1);
        for (const result of results) {
          expect(result).toBe(results[0]);
        }
      });
    });
  });

  describe('Given a memo whose flight is in progress', () => {
    describe('When peek() is called', () => {
      it('Then it returns the same promise the first get() returned', async () => {
        // Arrange
        const deferred = createDeferred<string>();
        const sut = createPromiseMemo(() => deferred.promise);

        // Act
        const inFlight = sut.get();
        const peeked = sut.peek();

        // Assert
        expect(peeked).toBe(inFlight);

        // Cleanup — settle the flight so it does not leak into later tests.
        deferred.resolve('settled');
        await inFlight;
      });
    });
  });

  describe('Given a populated memo', () => {
    describe('When clear() is called', () => {
      it('Then it returns the outgoing promise, peek() is undefined afterwards, and the next get() runs the factory a second time', async () => {
        // Arrange
        let factoryRuns = 0;
        const sut = createPromiseMemo(async () => {
          factoryRuns += 1;
          return factoryRuns;
        });
        const firstFlight = sut.get();
        await firstFlight;

        // Act
        const outgoing = sut.clear();
        const peeked = sut.peek();
        const secondFlight = sut.get();
        await secondFlight;

        // Assert
        expect(outgoing).toBe(firstFlight);
        expect(peeked).toBeUndefined();
        expect(factoryRuns).toBe(2);
      });
    });
  });

  describe('Given a factory that rejects', () => {
    describe('When get() is awaited and get() is called again', () => {
      it('Then the first await throws with data.code === "PERMISSION_DENIED" and the factory ran twice', async () => {
        // Arrange
        let factoryRuns = 0;
        const sut = createPromiseMemo<string>(async () => {
          factoryRuns += 1;
          throw permissionDenied('/blocked/path');
        });

        // Act
        let firstCaught: unknown;
        try {
          await sut.get();
        } catch (error) {
          firstCaught = error;
        }
        let secondCaught: unknown;
        try {
          await sut.get();
        } catch (error) {
          secondCaught = error;
        }

        // Assert — clear-on-reject: the second get() re-ran the factory.
        const data = (firstCaught as { data: { code: string } }).data;
        expect(data.code).toBe('PERMISSION_DENIED');
        expect(factoryRuns).toBe(2);
        expect(secondCaught).toBeDefined();
      });
    });
  });

  describe('Given a memo whose first flight is still in progress', () => {
    describe('When clear() then get() installs a successor and the first flight then rejects', () => {
      it('Then peek() still returns the successor promise, awaiting it resolves to the successor value, and the factory ran exactly twice across a following get()', async () => {
        // Arrange
        const calls: Array<Deferred<string>> = [];
        let factoryRuns = 0;
        const sut = createPromiseMemo<string>(() => {
          factoryRuns += 1;
          const deferred = createDeferred<string>();
          calls.push(deferred);
          return deferred.promise;
        });

        // Act
        const predecessorFlight = sut.get();
        // Deliberately reject the predecessor below; attach a silent handler so
        // it never surfaces as an unhandled rejection ahead of the try/catch.
        predecessorFlight.catch(() => {});
        sut.clear();
        const successorFlight = sut.get();
        calls[0]!.reject(new Error('predecessor failed'));
        let predecessorCaught: unknown;
        try {
          await predecessorFlight;
        } catch (error) {
          predecessorCaught = error;
        }
        const peeked = sut.peek();
        calls[1]!.resolve('successor-value');
        const successorValue = await successorFlight;
        const followingValue = await sut.get();

        // Assert — the identity guard kept the successor slot intact: the
        // predecessor's rejection handler found `slot !== pending` and did not
        // clear the memo the successor had already installed.
        expect(predecessorCaught).toBeDefined();
        expect(peeked).toBe(successorFlight);
        expect(successorValue).toBe('successor-value');
        expect(followingValue).toBe('successor-value');
        expect(factoryRuns).toBe(2);
      });
    });
  });
});
