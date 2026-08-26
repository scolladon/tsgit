import { describe, expect, it } from 'vitest';
import {
  deriveLimits,
  type MachineFacts,
} from '../../../../src/domain/concurrency/derive-limits.js';

/** `exactOptionalPropertyTypes` forbids `{ threadpoolWidth: undefined }` — omit the key entirely to represent "unknown". */
const factsOf = (cores: number | undefined, threadpoolWidth: number | undefined): MachineFacts => ({
  ...(cores !== undefined ? { cores } : {}),
  ...(threadpoolWidth !== undefined ? { threadpoolWidth } : {}),
});

describe('deriveLimits', () => {
  describe('Given the R18 matrix of cores x threadpool width', () => {
    describe('When deriving cpuBound', () => {
      it.each([
        { cores: 1, width: undefined, expected: 1, label: '1 core, threadpool width unset' },
        { cores: 2, width: undefined, expected: 1, label: '2 cores, threadpool width unset' },
        { cores: 11, width: undefined, expected: 1, label: '11 cores, threadpool width unset' },
        { cores: 128, width: undefined, expected: 1, label: '128 cores, threadpool width unset' },
        { cores: 1, width: 1, expected: 1, label: '1 core, threadpool width 1' },
        { cores: 2, width: 1, expected: 1, label: '2 cores, threadpool width 1' },
        { cores: 11, width: 1, expected: 1, label: '11 cores, threadpool width 1' },
        { cores: 128, width: 1, expected: 1, label: '128 cores, threadpool width 1' },
        { cores: 1, width: 4, expected: 1, label: '1 core, threadpool width 4' },
        { cores: 2, width: 4, expected: 2, label: '2 cores, threadpool width 4' },
        { cores: 11, width: 4, expected: 4, label: '11 cores, threadpool width 4' },
        { cores: 128, width: 4, expected: 4, label: '128 cores, threadpool width 4' },
        { cores: 1, width: 64, expected: 1, label: '1 core, threadpool width 64' },
        { cores: 2, width: 64, expected: 2, label: '2 cores, threadpool width 64' },
        { cores: 11, width: 64, expected: 11, label: '11 cores, threadpool width 64' },
        { cores: 128, width: 64, expected: 32, label: '128 cores, threadpool width 64 (cap)' },
      ])('Then cpuBound is $expected for $label', ({ cores, width, expected }) => {
        // Arrange
        const facts = factsOf(cores, width);
        const sut = deriveLimits;

        // Act
        const result = sut(facts);

        // Assert
        expect(result.cpuBound).toBe(expected);
      });
    });

    describe('When deriving ioBound', () => {
      it.each([
        { cores: 1, width: undefined, expected: 4, label: '1 core, threadpool width unset' },
        { cores: 2, width: undefined, expected: 4, label: '2 cores, threadpool width unset' },
        { cores: 11, width: undefined, expected: 4, label: '11 cores, threadpool width unset' },
        { cores: 128, width: undefined, expected: 4, label: '128 cores, threadpool width unset' },
        { cores: 1, width: 1, expected: 8, label: '1 core, threadpool width 1' },
        { cores: 2, width: 1, expected: 8, label: '2 cores, threadpool width 1' },
        { cores: 11, width: 1, expected: 8, label: '11 cores, threadpool width 1' },
        { cores: 128, width: 1, expected: 8, label: '128 cores, threadpool width 1' },
        { cores: 1, width: 4, expected: 32, label: '1 core, threadpool width 4' },
        { cores: 2, width: 4, expected: 32, label: '2 cores, threadpool width 4' },
        { cores: 11, width: 4, expected: 32, label: '11 cores, threadpool width 4' },
        { cores: 128, width: 4, expected: 32, label: '128 cores, threadpool width 4' },
        { cores: 1, width: 64, expected: 32, label: '1 core, threadpool width 64 (cap)' },
        { cores: 2, width: 64, expected: 32, label: '2 cores, threadpool width 64 (cap)' },
        { cores: 11, width: 64, expected: 32, label: '11 cores, threadpool width 64 (cap)' },
        { cores: 128, width: 64, expected: 32, label: '128 cores, threadpool width 64 (cap)' },
      ])('Then ioBound is $expected for $label', ({ cores, width, expected }) => {
        // Arrange
        const facts = factsOf(cores, width);
        const sut = deriveLimits;

        // Act
        const result = sut(facts);

        // Assert
        expect(result.ioBound).toBe(expected);
      });
    });
  });

  describe('Given no machine facts at all', () => {
    describe('When deriving limits', () => {
      it('Then cpuBound is the safe floor', () => {
        // Arrange
        const facts: MachineFacts = {};
        const sut = deriveLimits;

        // Act
        const result = sut(facts);

        // Assert
        expect(result.cpuBound).toBe(1);
      });

      it('Then ioBound is the safe floor', () => {
        // Arrange
        const facts: MachineFacts = {};
        const sut = deriveLimits;

        // Act
        const result = sut(facts);

        // Assert
        expect(result.ioBound).toBe(4);
      });
    });
  });

  describe('Given cores known and threadpool width unknown', () => {
    describe('When deriving limits', () => {
      it('Then cpuBound is the safe floor, not an unbounded assumption from cores alone', () => {
        // Arrange
        const facts = factsOf(128, undefined);
        const sut = deriveLimits;

        // Act
        const result = sut(facts);

        // Assert
        expect(result.cpuBound).toBe(1);
      });

      it('Then ioBound is the safe floor', () => {
        // Arrange
        const facts = factsOf(128, undefined);
        const sut = deriveLimits;

        // Act
        const result = sut(facts);

        // Assert
        expect(result.ioBound).toBe(4);
      });
    });
  });

  describe('Given threadpool width known and cores unknown', () => {
    describe('When deriving limits', () => {
      it('Then cpuBound is the safe floor, since min(cores, width) needs cores too', () => {
        // Arrange
        const facts = factsOf(undefined, 4);
        const sut = deriveLimits;

        // Act
        const result = sut(facts);

        // Assert
        expect(result.cpuBound).toBe(1);
      });

      it('Then ioBound is still derived from the known width alone', () => {
        // Arrange
        const facts = factsOf(undefined, 4);
        const sut = deriveLimits;

        // Act
        const result = sut(facts);

        // Assert
        expect(result.ioBound).toBe(32);
      });
    });
  });

  describe('Given a machine that reports zero cores', () => {
    describe('When deriving cpuBound', () => {
      it("Then the clamp's lower bound alone returns the floor", () => {
        // Arrange — threadpool width is generously wide, so only the cores=0
        // side can be driving the result down to the floor.
        const facts = factsOf(0, 64);
        const sut = deriveLimits;

        // Act
        const result = sut(facts);

        // Assert
        expect(result.cpuBound).toBe(1);
      });
    });
  });

  describe('Given a machine that reports more cores than the cap', () => {
    describe('When deriving cpuBound', () => {
      it("Then the clamp's upper bound alone returns the cap", () => {
        // Arrange — threadpool width is equally wide, so only the cap
        // (not the min-of-two-facts clause) is what limits the result.
        const facts = factsOf(1_000, 1_000);
        const sut = deriveLimits;

        // Act
        const result = sut(facts);

        // Assert
        expect(result.cpuBound).toBe(32);
      });
    });
  });
});
