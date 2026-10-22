import { describe, expect, it } from 'vitest';
import { buildRefFilter } from '../../../../src/domain/name-rev/ref-pattern.js';

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

  describe('Given multiple include patterns', () => {
    describe('When a ref matches one but not all of them', () => {
      it('Then matching any single include qualifies it', () => {
        // Arrange
        const sut = buildRefFilter({
          tags: false,
          refs: ['refs/tags/a*', 'refs/tags/z*'],
          exclude: [],
        });

        // Act + Assert — `refs/tags/apple` matches `a*` only (`some`, not `every`).
        expect(sut.qualifies('refs/tags/apple')).toBe(true);
      });
    });
  });

  describe('Given an include pattern using a bracket expression', () => {
    describe('When qualifying', () => {
      it('Then the shared glob dialect matches through buildRefFilter too', () => {
        // Arrange
        const sut = buildRefFilter({ tags: false, refs: ['refs/heads/m[a-z]in'], exclude: [] });

        // Act + Assert
        expect(sut.qualifies('refs/heads/main')).toBe(true);
        expect(sut.qualifies('refs/heads/mMin')).toBe(false);
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
  describe('Given an include pattern matching a suffix of the ref', () => {
    describe('When qualifying', () => {
      it.each([
        { refs: ['v*'], ref: 'refs/tags/v1.0', expected: true, label: 'a bare name pattern' },
        {
          refs: ['tags/*'],
          ref: 'refs/tags/v1.0',
          expected: true,
          label: 'a partial path pattern',
        },
        { refs: ['main'], ref: 'refs/heads/main', expected: true, label: 'a branch short name' },
        {
          refs: ['ags/v1.0'],
          ref: 'refs/tags/v1.0',
          expected: false,
          label: 'a mid-segment suffix',
        },
      ])('Then $label', ({ refs, ref, expected }) => {
        // Arrange
        const sut = buildRefFilter({ tags: false, refs, exclude: [] });

        // Act
        const result = sut.qualifies(ref);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given an exclude pattern matching a suffix of the ref', () => {
    describe('When qualifying', () => {
      it.each([
        { exclude: ['tags/*'], label: 'a partial path pattern' },
        { exclude: ['v*'], label: 'a bare name pattern' },
      ])('Then $label drops it', ({ exclude }) => {
        // Arrange
        const sut = buildRefFilter({ tags: false, refs: [], exclude });

        // Act
        const result = sut.qualifies('refs/tags/v1.0');

        // Assert
        expect(result).toBe(false);
      });
    });
  });
  describe('Given include patterns and a tag ref', () => {
    describe('When asking whether the name is abbreviated', () => {
      it.each([
        { refs: ['v*'], expected: true, label: 'a suffix match abbreviates' },
        { refs: ['refs/tags/*'], expected: false, label: 'a full-ref match does not' },
        {
          refs: ['refs/tags/v*', 'v1.*'],
          expected: true,
          label: 'any suffix-matching include abbreviates',
        },
        { refs: ['*1.0'], expected: false, label: 'a first match at offset 0 does not' },
        { refs: [], expected: false, label: 'no include does not' },
      ])('Then $label', ({ refs, expected }) => {
        // Arrange
        const sut = buildRefFilter({ tags: false, refs, exclude: [] });

        // Act
        const result = sut.abbreviates('refs/tags/v1.0');

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
