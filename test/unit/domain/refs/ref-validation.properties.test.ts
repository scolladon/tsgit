import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RefName } from '../../../../src/domain/objects/index.js';
import { isRefnameSafe } from '../../../../src/domain/refs/ref-validation.js';
import { arbRefName } from './arbitraries.js';

describe('Given any arbRefName under refs/ followed by a slash', () => {
  describe('When checking it', () => {
    it('Then it is unsafe', () => {
      // Arrange
      const sut = isRefnameSafe;

      // Act + Assert
      fc.assert(
        fc.property(arbRefName(), (name) => {
          expect(sut(`refs/${name}/` as RefName)).toBe(false);
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given any arbRefName under refs/ with a dot-led component appended', () => {
  describe('When checking it', () => {
    it('Then it is safe', () => {
      // Arrange
      const sut = isRefnameSafe;

      // Act + Assert
      fc.assert(
        fc.property(arbRefName(), (name) => {
          expect(sut(`refs/${name}/.${name}` as RefName)).toBe(true);
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given any arbRefName under refs/', () => {
  describe('When checking it', () => {
    it('Then it is safe', () => {
      // Arrange
      const sut = isRefnameSafe;

      // Act + Assert
      fc.assert(
        fc.property(arbRefName(), (name) => {
          expect(sut(`refs/${name}` as RefName)).toBe(true);
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given any non-empty run of [A-Z_]', () => {
  describe('When checking it', () => {
    it('Then it is safe', () => {
      // Arrange
      const sut = isRefnameSafe;

      // Act + Assert
      fc.assert(
        fc.property(fc.stringMatching(/^[A-Z_]{1,16}$/), (name) => {
          expect(sut(name as RefName)).toBe(true);
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe("Given a root-syntax name carrying a '-', a digit or a lowercase letter", () => {
  describe('When checking it', () => {
    it('Then it is unsafe', () => {
      // Arrange
      const sut = isRefnameSafe;
      const rootRun = fc.stringMatching(/^[A-Z_]{0,8}$/);
      const outsider = fc.stringMatching(/^[-0-9a-z]$/);

      // Act + Assert
      fc.assert(
        fc.property(rootRun, outsider, rootRun, (before, odd, after) => {
          expect(sut(`${before}${odd}${after}` as RefName)).toBe(false);
        }),
        { numRuns: 100 },
      );
    });
  });
});
