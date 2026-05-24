import { expectTypeOf } from 'expect-type';
import { describe, expect, it, vi } from 'vitest';
import { pipe } from '../../../src/operators/pipe.js';

describe('pipe', () => {
  describe('Given no functions', () => {
    describe('When pipe(42) is called', () => {
      it('Then it returns 42', () => {
        // Arrange / Act
        const sut = pipe(42);

        // Assert
        expect(sut).toBe(42);
      });
    });
  });

  describe('Given a single function f', () => {
    describe('When pipe(x, f) is called', () => {
      it('Then it returns f(x)', () => {
        // Arrange
        const f = (n: number): number => n + 1;

        // Act
        const sut = pipe(3, f);

        // Assert
        expect(sut).toBe(4);
      });
    });
  });

  describe('Given two functions f and g', () => {
    describe('When pipe(x, f, g) is called', () => {
      it('Then it returns g(f(x)) left-to-right', () => {
        // Arrange
        const f = (n: number): number => n + 1;
        const g = (n: number): string => `v=${n}`;

        // Act
        const sut = pipe(3, f, g);

        // Assert
        expect(sut).toBe('v=4');
      });
    });
  });

  describe('Given an async function returning Promise<B>', () => {
    describe('When piped', () => {
      it('Then the next function receives a Promise (pipe never awaits)', () => {
        // Arrange
        const asyncFn = async (n: number): Promise<number> => n + 1;
        const receiver = vi.fn((v: Promise<number>) => v);

        // Act
        const sut = pipe(3, asyncFn, receiver);

        // Assert
        expect(receiver).toHaveBeenCalledTimes(1);
        expect(sut).toBeInstanceOf(Promise);
      });
    });
  });

  describe('Given a function that throws at step 2 of 3', () => {
    describe('When pipe is called', () => {
      it('Then step 3 is never invoked', () => {
        // Arrange
        const boom = new Error('boom');
        const step1 = (n: number): number => n + 1;
        const step2 = (_n: number): number => {
          throw boom;
        };
        const step3 = vi.fn((n: number) => n);

        // Act / Assert
        expect(() => pipe(3, step1, step2, step3)).toThrow(boom);
        expect(step3).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given nine unary functions', () => {
    describe('When pipe is invoked with all nine', () => {
      it('Then output equals their sequential composition', () => {
        // Arrange
        const add = (n: number): number => n + 1;

        // Act
        const sut = pipe(0, add, add, add, add, add, add, add, add, add);

        // Assert
        expect(sut).toBe(9);
      });
    });
  });

  describe('Given ten unary functions beyond the 9 overloads', () => {
    describe('When pipe is invoked via an as-cast', () => {
      it('Then output equals their sequential composition', () => {
        // Arrange
        const add = (n: number): number => n + 1;
        const tenFns = [add, add, add, add, add, add, add, add, add, add] as const;
        const pipeUntyped = pipe as unknown as (
          initial: number,
          ...fns: ReadonlyArray<(n: number) => number>
        ) => number;

        // Act — cast-based escape hatch, exercises rest-parameter path with >9 args
        const sut = pipeUntyped(0, ...tenFns);

        // Assert
        expect(sut).toBe(10);
      });
    });
  });

  describe('Given an empty rest array via pipe(x, ...([] as []))', () => {
    describe('When invoked through the rest-parameter path', () => {
      it('Then output equals the seed', () => {
        // Arrange
        const empty: [] = [];

        // Act — forces the reduce over a zero-length rest array (distinct from overload-1 match)
        const sut = pipe(7, ...(empty as []));

        // Assert
        expect(sut).toBe(7);
      });
    });
  });
});

describe('pipe — type-level overloads', () => {
  describe('Given arity 1', () => {
    describe('When invoked', () => {
      it('Then result is the seed type', () => {
        // Arrange + Assert
        expectTypeOf(pipe(1)).toEqualTypeOf<number>();
      });
    });
  });

  describe('Given arity 2', () => {
    describe('When invoked', () => {
      it('Then result is the last function return type', () => {
        // Arrange + Assert
        expectTypeOf(pipe(1, (n: number) => n.toString())).toEqualTypeOf<string>();
      });
    });
  });

  describe('Given arity 5', () => {
    describe('When invoked', () => {
      it('Then result is the fifth function return type', () => {
        // Arrange + Assert
        expectTypeOf(
          pipe(
            1,
            (n: number) => n + 1,
            (n: number) => n * 2,
            (n: number) => n.toString(),
            (s: string) => s.length,
            (n: number) => Boolean(n),
          ),
        ).toEqualTypeOf<boolean>();
      });
    });
  });

  describe('Given arity 9', () => {
    describe('When invoked', () => {
      it('Then result is the ninth function return type', () => {
        // Arrange + Assert
        expectTypeOf(
          pipe(
            1,
            (n: number) => n + 1,
            (n: number) => n + 1,
            (n: number) => n + 1,
            (n: number) => n + 1,
            (n: number) => n + 1,
            (n: number) => n + 1,
            (n: number) => n + 1,
            (n: number) => `r=${n}`,
          ),
        ).toEqualTypeOf<string>();
      });
    });
  });
});
