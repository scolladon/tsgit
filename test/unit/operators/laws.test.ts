import fc from 'fast-check';
import { describe, it } from 'vitest';
import { filter, flatMap, groupBy, map, take, toArray } from '../../../src/operators/index.js';

async function* toAsyncIterable<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

describe('operator composition laws', () => {
  describe('Given the law "take(n) ∘ take(m) ≡ take(min(n, m))"', () => {
    describe('When evaluated', () => {
      it('Then it holds', async () => {
        // Arrange + Assert
        await fc.assert(
          fc.asyncProperty(
            fc.nat({ max: 30 }),
            fc.nat({ max: 30 }),
            fc.array(fc.integer(), { maxLength: 30 }),
            async (n, m, source) => {
              const composed = await toArray(
                take<number>(n)(take<number>(m)(toAsyncIterable(source))),
              );
              const minimal = await toArray(take<number>(Math.min(n, m))(toAsyncIterable(source)));
              return (
                composed.length === minimal.length && composed.every((v, i) => v === minimal[i])
              );
            },
          ),
          { numRuns: 50 },
        );
      });
    });
  });

  describe('Given the law "filter(p) ∘ filter(q) ≡ filter(x => q(x) && p(x))"', () => {
    describe('When evaluated', () => {
      it('Then it holds', async () => {
        // Arrange + Assert
        await fc.assert(
          fc.asyncProperty(fc.array(fc.integer(), { maxLength: 30 }), async (source) => {
            const p = (n: number): boolean => n % 2 === 0;
            const q = (n: number): boolean => n > 0;
            const composed = await toArray(filter(p)(filter(q)(toAsyncIterable(source))));
            const fused = await toArray(
              filter((x: number) => q(x) && p(x))(toAsyncIterable(source)),
            );
            return composed.length === fused.length && composed.every((v, i) => v === fused[i]);
          }),
          { numRuns: 50 },
        );
      });
    });
  });

  describe('Given the law "map(g) ∘ map(f) ≡ map(x => g(f(x)))"', () => {
    describe('When evaluated', () => {
      it('Then it holds', async () => {
        // Arrange + Assert
        await fc.assert(
          fc.asyncProperty(fc.array(fc.integer(), { maxLength: 30 }), async (source) => {
            const f = (n: number): number => n + 1;
            const g = (n: number): string => `v=${n}`;
            const composed = await toArray(map(g)(map(f)(toAsyncIterable(source))));
            const fused = await toArray(map((x: number) => g(f(x)))(toAsyncIterable(source)));
            return composed.length === fused.length && composed.every((v, i) => v === fused[i]);
          }),
          { numRuns: 50 },
        );
      });
    });
  });

  describe('Given the law "filter(p) ∘ map(f) ≡ map(f) ∘ filter(x => p(f(x)))"', () => {
    describe('When evaluated', () => {
      it('Then it holds', async () => {
        // Arrange + Assert
        await fc.assert(
          fc.asyncProperty(fc.array(fc.integer(), { maxLength: 30 }), async (source) => {
            const f = (n: number): number => n * 2;
            const p = (n: number): boolean => n > 0;
            const left = await toArray(filter(p)(map(f)(toAsyncIterable(source))));
            const right = await toArray(
              map(f)(filter((x: number) => p(f(x)))(toAsyncIterable(source))),
            );
            return left.length === right.length && left.every((v, i) => v === right[i]);
          }),
          { numRuns: 50 },
        );
      });
    });
  });

  describe('Given the law "toArray ∘ flatMap(x => [x]) ≡ toArray"', () => {
    describe('When evaluated', () => {
      it('Then it holds', async () => {
        // Arrange + Assert
        await fc.assert(
          fc.asyncProperty(fc.array(fc.integer(), { maxLength: 30 }), async (source) => {
            const lifted = await toArray(flatMap((x: number) => [x])(toAsyncIterable(source)));
            const direct = await toArray(toAsyncIterable(source));
            return lifted.length === direct.length && lifted.every((v, i) => v === direct[i]);
          }),
          { numRuns: 50 },
        );
      });
    });
  });

  describe('Given the law "toArray(source).length === N for finite source of length N"', () => {
    describe('When evaluated', () => {
      it('Then it holds', async () => {
        // Arrange + Assert
        await fc.assert(
          fc.asyncProperty(fc.array(fc.integer(), { maxLength: 50 }), async (source) => {
            const result = await toArray(toAsyncIterable(source));
            return result.length === source.length;
          }),
          { numRuns: 50 },
        );
      });
    });
  });

  describe('Given the law "toArray ∘ map(x => x) ≡ toArray"', () => {
    describe('When evaluated', () => {
      it('Then it holds', async () => {
        // Arrange + Assert
        await fc.assert(
          fc.asyncProperty(fc.array(fc.integer(), { maxLength: 30 }), async (source) => {
            const identity = await toArray(map((x: number) => x)(toAsyncIterable(source)));
            const direct = await toArray(toAsyncIterable(source));
            return identity.length === direct.length && identity.every((v, i) => v === direct[i]);
          }),
          { numRuns: 50 },
        );
      });
    });
  });

  describe('Given the law "toArray ∘ filter(() => true) ≡ toArray"', () => {
    describe('When evaluated', () => {
      it('Then it holds', async () => {
        // Arrange + Assert
        await fc.assert(
          fc.asyncProperty(fc.array(fc.integer(), { maxLength: 30 }), async (source) => {
            const kept = await toArray(filter(() => true)(toAsyncIterable(source)));
            const direct = await toArray(toAsyncIterable(source));
            return kept.length === direct.length && kept.every((v, i) => v === direct[i]);
          }),
          { numRuns: 50 },
        );
      });
    });
  });

  describe('Given the law "toArray ∘ filter(() => false) ≡ []"', () => {
    describe('When evaluated', () => {
      it('Then it holds', async () => {
        // Arrange + Assert
        await fc.assert(
          fc.asyncProperty(fc.array(fc.integer(), { maxLength: 30 }), async (source) => {
            const empty = await toArray(filter(() => false)(toAsyncIterable(source)));
            return empty.length === 0;
          }),
          { numRuns: 50 },
        );
      });
    });
  });

  describe('Given the law "Array.from(groupBy(k)(source).values()).flat() is a permutation of toArray(source)"', () => {
    describe('When evaluated', () => {
      it('Then it holds', async () => {
        // Arrange + Assert
        await fc.assert(
          fc.asyncProperty(fc.array(fc.integer(), { maxLength: 30 }), async (source) => {
            const grouped = await groupBy((n: number) => n % 4)(toAsyncIterable(source));
            const flat = [...grouped.values()].flat();
            const sortedIn = [...source].sort((a, b) => a - b);
            const sortedOut = [...flat].sort((a, b) => a - b);
            return flat.length === source.length && sortedIn.every((v, i) => v === sortedOut[i]);
          }),
          { numRuns: 50 },
        );
      });
    });
  });
});
