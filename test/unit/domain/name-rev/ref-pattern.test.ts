import { describe, expect, it } from 'vitest';
import { buildRefFilter, matchRefGlob } from '../../../../src/domain/name-rev/ref-pattern.js';

describe('matchRefGlob', () => {
  describe('Given a `*` pattern and a nested ref', () => {
    describe('When matching', () => {
      it('Then `*` crosses slashes', () => {
        // Arrange + Act
        const sut = matchRefGlob('refs/tags/*', 'refs/tags/rel/v1');

        // Assert
        expect(sut).toBe(true);
      });
    });
  });

  describe('Given a `?` pattern', () => {
    describe('When matching one character', () => {
      it('Then `?` matches a single character including a slash', () => {
        // Arrange + Act + Assert
        expect(matchRefGlob('refs/tags/v?', 'refs/tags/v1')).toBe(true);
        expect(matchRefGlob('a?b', 'a/b')).toBe(true);
      });
    });
  });

  describe('Given a literal pattern', () => {
    describe('When matching', () => {
      it('Then it matches iff the ref is equal', () => {
        // Arrange + Act + Assert
        expect(matchRefGlob('refs/tags/v1', 'refs/tags/v1')).toBe(true);
        expect(matchRefGlob('refs/tags/v1', 'refs/tags/v2')).toBe(false);
      });
    });
  });

  describe('Given a pattern that matches only a prefix', () => {
    describe('When matching', () => {
      it('Then the match is anchored at both ends', () => {
        // Arrange + Act
        const sut = matchRefGlob('tags/*', 'refs/tags/x');

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given a pattern with a regex metacharacter', () => {
    describe('When matching', () => {
      it('Then the metacharacter is treated literally', () => {
        // Arrange + Act + Assert
        expect(matchRefGlob('refs/tags/v1.0', 'refs/tags/v1.0')).toBe(true);
        expect(matchRefGlob('refs/tags/v1.0', 'refs/tags/v1x0')).toBe(false);
      });
    });
  });
});

describe('buildRefFilter', () => {
  describe('Given any options and the HEAD ref', () => {
    describe('When qualifying', () => {
      it('Then HEAD never qualifies', () => {
        // Arrange
        const sut = buildRefFilter({ tags: false, refs: [], exclude: [] });

        // Act + Assert
        expect(sut.qualifies('HEAD')).toBe(false);
      });
    });
  });

  describe('Given tags-only and a non-tag ref', () => {
    describe('When qualifying', () => {
      it('Then the non-tag ref is dropped', () => {
        // Arrange
        const sut = buildRefFilter({ tags: true, refs: [], exclude: [] });

        // Act + Assert
        expect(sut.qualifies('refs/heads/main')).toBe(false);
        expect(sut.qualifies('refs/tags/v1')).toBe(true);
      });
    });
  });

  describe('Given no include patterns', () => {
    describe('When qualifying', () => {
      it('Then every ref is included', () => {
        // Arrange
        const sut = buildRefFilter({ tags: false, refs: [], exclude: [] });

        // Act + Assert
        expect(sut.qualifies('refs/heads/main')).toBe(true);
      });
    });
  });

  describe('Given an include pattern', () => {
    describe('When qualifying a non-matching ref', () => {
      it('Then it must match an include to qualify', () => {
        // Arrange
        const sut = buildRefFilter({ tags: false, refs: ['refs/tags/*'], exclude: [] });

        // Act + Assert
        expect(sut.qualifies('refs/tags/v1')).toBe(true);
        expect(sut.qualifies('refs/heads/main')).toBe(false);
      });
    });
  });

  describe('Given an exclude pattern matching an otherwise-included ref', () => {
    describe('When qualifying', () => {
      it('Then the exclude drops it', () => {
        // Arrange
        const sut = buildRefFilter({ tags: false, refs: [], exclude: ['refs/tags/*'] });

        // Act + Assert
        expect(sut.qualifies('refs/tags/v1')).toBe(false);
        expect(sut.qualifies('refs/heads/main')).toBe(true);
      });
    });
  });
});
