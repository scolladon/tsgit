import { describe, expect, it } from 'vitest';
import {
  abortableRange,
  awaitable,
  pullCounter,
  throwingAt,
  throwingPredicate,
  trackedPipeline4,
  trackedRange,
} from './fixtures.js';

describe('trackedRange', () => {
  describe('Given a trackedRange(3)', () => {
    describe('When iteration completes normally', () => {
      it('Then returnCalled() is false', async () => {
        // Arrange
        const sut = trackedRange(3);

        // Act
        const collected: number[] = [];
        for await (const v of sut.source) {
          collected.push(v);
        }

        // Assert
        expect(collected).toEqual([0, 1, 2]);
        expect(sut.returnCalled()).toBe(false);
      });
    });
  });

  describe('Given a trackedRange(10)', () => {
    describe('When consumer breaks at item 3', () => {
      it('Then returnCalled() is true', async () => {
        // Arrange
        const sut = trackedRange(10);

        // Act
        const collected: number[] = [];
        for await (const v of sut.source) {
          collected.push(v);
          if (collected.length >= 3) break;
        }

        // Assert
        expect(sut.returnCalled()).toBe(true);
      });
    });
  });
});

describe('pullCounter', () => {
  describe('Given a pullCounter', () => {
    describe('When no iteration happens', () => {
      it('Then pullCount() is 0', () => {
        // Arrange / Act
        const sut = pullCounter();

        // Assert
        expect(sut.pullCount()).toBe(0);
      });
    });
    describe('When consumer pulls 5 items', () => {
      it('Then pullCount() is 5', async () => {
        // Arrange
        const sut = pullCounter();

        // Act
        let n = 0;
        for await (const _ of sut.source) {
          n += 1;
          if (n >= 5) break;
        }

        // Assert
        expect(sut.pullCount()).toBe(5);
      });
    });
  });
});

describe('throwingAt', () => {
  describe('Given a throwingAt(2, 10)', () => {
    describe('When consumer pulls past item 1', () => {
      it('Then iteration throws on item 2', async () => {
        // Arrange
        const sut = throwingAt(2, 10);
        const seen: number[] = [];

        // Act / Assert
        await expect(
          (async () => {
            for await (const v of sut) {
              seen.push(v);
            }
          })(),
        ).rejects.toThrow(/threw at item 2/);
        expect(seen).toEqual([0, 1]);
      });
    });
  });
});

describe('awaitable', () => {
  describe('Given awaitable(() => true)', () => {
    describe('When awaited', () => {
      it('Then resolves to true AND is NOT a Promise', async () => {
        // Arrange
        const sut = awaitable(() => true);

        // Assert (structural)
        expect(sut).not.toBeInstanceOf(Promise);
        expect(Object.getPrototypeOf(sut)).not.toBe(Promise.prototype);

        // Act
        const resolved = await sut;

        // Assert
        expect(resolved).toBe(true);
      });
    });
  });
});

describe('abortableRange', () => {
  describe('Given abortableRange(3, 10)', () => {
    describe('When iterated to completion', () => {
      it('Then exactly [0,1,2] is yielded', async () => {
        // Arrange
        const sut = abortableRange(3, 10);

        // Act
        const seen: number[] = [];
        for await (const v of sut) {
          seen.push(v);
        }

        // Assert
        expect(seen).toEqual([0, 1, 2]);
      });
    });
  });
});

describe('throwingPredicate', () => {
  describe('Given throwingPredicate(x => x === 2, err)', () => {
    describe('When called with 1 then 2', () => {
      it('Then 1 resolves false and 2 rejects with err', async () => {
        // Arrange
        const boom = new Error('boom');
        const sut = throwingPredicate<number>((x) => x === 2, boom);

        // Act / Assert
        await expect(sut(1)).resolves.toBe(false);
        await expect(sut(2)).rejects.toBe(boom);
      });
    });
  });
});

describe('trackedPipeline4', () => {
  describe('Given a trackedPipeline4 composed with a manual for-await consumer breaking at 3', () => {
    describe('When iteration exits', () => {
      it('Then all four stage return flags are true', async () => {
        // Arrange
        const sut = trackedPipeline4(100);
        const pipeline = sut.stage3(sut.stage2(sut.stage1(sut.stage0)));

        // Act
        const seen: number[] = [];
        for await (const v of pipeline) {
          seen.push(v);
          if (seen.length >= 3) break;
        }

        // Assert
        expect(seen).toEqual([0, 1, 2]);
        const flags = sut.returnCalled();
        expect(flags.s0).toBe(true);
        expect(flags.s1).toBe(true);
        expect(flags.s2).toBe(true);
        expect(flags.s3).toBe(true);
      });
    });
  });
});
