import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { take } from '../../../src/operators/take.js';
import { toArray } from '../../../src/operators/to-array.js';
import {
  abortableRange,
  fromArray,
  pullCounter,
  trackedPipeline4,
  trackedRange,
} from './fixtures.js';

describe('take', () => {
  describe('Given take(0) on pullCounter', () => {
    describe('When iterated to completion', () => {
      it('Then pullCount is 0', async () => {
        // Arrange
        const source = pullCounter();
        const sut = take<number>(0);

        // Act
        const result = await toArray(sut(source.source));

        // Assert
        expect(result).toEqual([]);
        expect(source.pullCount()).toBe(0);
      });
    });
  });

  describe('Given a source of length 5 and take(3)', () => {
    describe('When iterated', () => {
      it('Then exactly [0,1,2] is yielded', async () => {
        // Arrange
        const sut = take<number>(3);

        // Act
        const result = await toArray(sut(fromArray([0, 1, 2, 3, 4])));

        // Assert
        expect(result).toEqual([0, 1, 2]);
      });
    });
  });

  describe('Given a source of length 2 and take(5)', () => {
    describe('When iterated', () => {
      it('Then all 2 items yielded, no error', async () => {
        // Arrange
        const sut = take<number>(5);

        // Act
        const result = await toArray(sut(fromArray([0, 1])));

        // Assert
        expect(result).toEqual([0, 1]);
      });
    });
  });

  describe('Given take(1) on pullCounter', () => {
    describe('When iterated to completion', () => {
      it('Then pullCount() === 1', async () => {
        // Arrange
        const source = pullCounter();
        const sut = take<number>(1);

        // Act
        await toArray(sut(source.source));

        // Assert
        expect(source.pullCount()).toBe(1);
      });
    });
  });

  describe('Given take(N) on a source of exactly N items', () => {
    describe('When invoked', () => {
      it('Then pullCount() === N (no extra next())', async () => {
        // Arrange — bounded pull-counting source
        let pulls = 0;
        async function* bounded(n: number): AsyncIterable<number> {
          for (let i = 0; i < n; i += 1) {
            pulls += 1;
            yield i;
          }
        }
        const sut = take<number>(4);

        // Act
        const result = await toArray(sut(bounded(4)));

        // Assert
        expect(result).toEqual([0, 1, 2, 3]);
        expect(pulls).toBe(4);
      });
    });
  });

  describe('Given take(3) and a trackedRange(100)', () => {
    describe('When iteration cuts after 3', () => {
      it('Then trackedRange.returnCalled() is true', async () => {
        // Arrange
        const source = trackedRange(100);
        const sut = take<number>(3);

        // Act
        const result = await toArray(sut(source.source));

        // Assert
        expect(result).toEqual([0, 1, 2]);
        expect(source.returnCalled()).toBe(true);
      });
    });
  });

  describe('Given take(-1)', () => {
    describe('When invoked', () => {
      it('Then RangeError /non-negative integer/', () => {
        // Arrange
        try {
          take<number>(-1);
          // Assert
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(RangeError);
          expect((error as Error).message).toMatch(/non-negative integer/);
        }
      });
    });
  });

  describe('Given take(-2)', () => {
    describe('When invoked', () => {
      it('Then RangeError /non-negative integer/', () => {
        // Arrange
        try {
          take<number>(-2);
          // Assert
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(RangeError);
          expect((error as Error).message).toMatch(/non-negative integer/);
        }
      });
    });
  });

  describe('Given take(1.5)', () => {
    describe('When invoked', () => {
      it('Then RangeError /non-negative integer/', () => {
        // Arrange
        try {
          take<number>(1.5);
          // Assert
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(RangeError);
          expect((error as Error).message).toMatch(/non-negative integer/);
        }
      });
    });
  });

  describe('Given take(NaN)', () => {
    describe('When invoked', () => {
      it('Then RangeError /non-negative integer/', () => {
        // Arrange
        try {
          take<number>(Number.NaN);
          // Assert
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(RangeError);
          expect((error as Error).message).toMatch(/non-negative integer/);
        }
      });
    });
  });

  describe('Given take(Infinity)', () => {
    describe('When invoked', () => {
      it('Then RangeError /non-negative integer/', () => {
        // Arrange
        try {
          take<number>(Number.POSITIVE_INFINITY);
          // Assert
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(RangeError);
          expect((error as Error).message).toMatch(/non-negative integer/);
        }
      });
    });
  });

  describe('Given a trackedRange(100) and a consumer that throws before take cap', () => {
    describe('When throw exits', () => {
      it('Then returnCalled() is true', async () => {
        // Arrange
        const source = trackedRange(100);
        const sut = take<number>(50);

        // Act
        let count = 0;
        try {
          for await (const _ of sut(source.source)) {
            count += 1;
            if (count >= 3) throw new Error('consumer-throw');
          }
        } catch {
          // swallow
        }

        // Assert
        expect(source.returnCalled()).toBe(true);
      });
    });
  });

  describe('Given an abortableRange(3, 100) under take(10)', () => {
    describe('When iterated to completion', () => {
      it('Then [0,1,2] is yielded', async () => {
        // Arrange
        const source = abortableRange(3, 100);
        const sut = take<number>(10);

        // Act
        const result = await toArray(sut(source));

        // Assert
        expect(result).toEqual([0, 1, 2]);
      });
    });
  });

  describe('Given a trackedPipeline4(1000) wired stage3(stage2(stage1(stage0))) and take(3)', () => {
    describe('When iterated via manual for-await + break', () => {
      it('Then all 4 stage flags are true', async () => {
        // Arrange
        const stages = trackedPipeline4(1000);
        const pipeline = stages.stage3(stages.stage2(stages.stage1(stages.stage0)));
        const sut = take<number>(3);

        // Act — manual consumer (NOT toArray / pipe), break after 3
        const seen: number[] = [];
        for await (const v of sut(pipeline)) {
          seen.push(v);
          if (seen.length >= 3) break;
        }

        // Assert
        expect(seen).toEqual([0, 1, 2]);
        const flags = stages.returnCalled();
        expect(flags).toEqual({ s0: true, s1: true, s2: true, s3: true });
      });
    });
  });

  describe('Given a trackedPipeline4(1000) and take(3) as SOLE cascade initiator', () => {
    describe('When consumer drains without break', () => {
      it('Then all 4 stage flags are true', async () => {
        // Arrange — no consumer break. take(3) alone must propagate the cascade
        //           via its own `return` when `yielded >= count`.
        const stages = trackedPipeline4(1000);
        const pipeline = stages.stage3(stages.stage2(stages.stage1(stages.stage0)));
        const sut = take<number>(3);

        // Act — drain naturally; take returns from its generator body
        const seen: number[] = [];
        for await (const v of sut(pipeline)) {
          seen.push(v);
        }

        // Assert
        expect(seen).toEqual([0, 1, 2]);
        const flags = stages.returnCalled();
        expect(flags).toEqual({ s0: true, s1: true, s2: true, s3: true });
      });
    });
  });

  describe('Given the property "take(n)(source) yields exactly min(n, L) items equal to the first min(n, L) of source"', () => {
    describe('When sampled', () => {
      it('Then it holds', async () => {
        // Arrange + Assert
        await fc.assert(
          fc.asyncProperty(
            fc.nat({ max: 50 }),
            fc.array(fc.integer(), { maxLength: 50 }),
            async (n, source) => {
              const sut = take<number>(n);
              const result = await toArray(sut(fromArray(source)));
              return (
                result.length === Math.min(n, source.length) &&
                result.every((v, i) => v === source[i])
              );
            },
          ),
          { numRuns: 50 },
        );
      });
    });
  });
});
