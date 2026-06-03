import { describe, expect, it } from 'vitest';
import { tagNameMatches } from '../../../../src/domain/describe/match.js';

describe('tagNameMatches', () => {
  describe('Given no include or exclude patterns', () => {
    describe('When matching any name', () => {
      it('Then the name is included (identity)', () => {
        // Arrange + Act
        const sut = tagNameMatches('v1.0', [], []);

        // Assert
        expect(sut).toBe(true);
      });
    });
  });

  describe('Given an include pattern the name matches', () => {
    describe('When matching', () => {
      it('Then it is included', () => {
        // Arrange + Act
        const sut = tagNameMatches('v1.0', ['v*'], []);

        // Assert
        expect(sut).toBe(true);
      });
    });
  });

  describe('Given an include pattern the name does not match', () => {
    describe('When matching', () => {
      it('Then it is excluded', () => {
        // Arrange + Act
        const sut = tagNameMatches('rc-1', ['v*'], []);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given an exclude pattern the name matches', () => {
    describe('When matching', () => {
      it('Then it is dropped even with no include patterns', () => {
        // Arrange + Act
        const sut = tagNameMatches('rc-1', [], ['rc*']);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given both include and exclude matching the name', () => {
    describe('When matching', () => {
      it('Then exclusion wins', () => {
        // Arrange + Act
        const sut = tagNameMatches('v1-rc', ['v*'], ['*rc']);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given a star pattern and a slashed name', () => {
    describe('When matching', () => {
      it('Then * does not cross the slash', () => {
        // Arrange + Act
        const sut = tagNameMatches('release/v1', ['release*'], []);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given an anchored pattern and a name with a leading segment', () => {
    describe('When matching', () => {
      it('Then the match is anchored at the start (no unanchored suffix match)', () => {
        // Arrange + Act — an unanchored matcher would accept the `sub/` prefix.
        const sut = tagNameMatches('sub/v1.0', ['v1.0'], []);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given several include patterns of which only one matches', () => {
    describe('When matching', () => {
      it('Then any single match includes the name (some, not every)', () => {
        // Arrange + Act
        const sut = tagNameMatches('v1.0', ['v*', 'x*'], []);

        // Assert
        expect(sut).toBe(true);
      });
    });
  });
});
