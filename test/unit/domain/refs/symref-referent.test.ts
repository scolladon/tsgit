import { describe, expect, it } from 'vitest';
import {
  isOutsideRefsNamespace,
  isRootRefName,
  isValidSymrefReferent,
} from '../../../../src/domain/refs/symref-referent.js';

describe('isRootRefName', () => {
  describe('Given a name git accepts as a root ref', () => {
    describe('When isRootRefName runs', () => {
      it.each([
        'HEAD',
        'ORIG_HEAD',
        'BAR_HEAD',
        'FOO_HEAD',
        'A_HEAD',
        '_HEAD',
        'FO-O_HEAD',
        'BISECT_HEAD',
        'AUTO_MERGE',
        'BISECT_EXPECTED_REV',
        'MERGE_AUTOSTASH',
        'NOTES_MERGE_PARTIAL',
        'NOTES_MERGE_REF',
      ])('Then %s is a root ref', (name) => {
        // Arrange
        const sut = isRootRefName;

        // Act
        const result = sut(name);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a pseudoref', () => {
    describe('When isRootRefName runs', () => {
      it.each(['FETCH_HEAD', 'MERGE_HEAD'])('Then %s is not a root ref', (name) => {
        // Arrange
        const sut = isRootRefName;

        // Act
        const result = sut(name);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a name outside root-ref syntax', () => {
    describe('When isRootRefName runs', () => {
      it.each(['FOO1_HEAD', 'Foo_HEAD', 'refs', '', 'FOO', 'HEADER', 'refs/heads/main'])(
        'Then "%s" is not a root ref',
        (name) => {
          // Arrange
          const sut = isRootRefName;

          // Act
          const result = sut(name);

          // Assert
          expect(result).toBe(false);
        },
      );
    });
  });
});

describe('isValidSymrefReferent', () => {
  describe('Given a referent git accepts', () => {
    describe('When isValidSymrefReferent runs', () => {
      it.each([
        'refs/foo',
        'refs/heads/@',
        'foo/bar',
        'HEAD',
        'ORIG_HEAD',
        'FOO_HEAD',
        'AUTO_MERGE',
        'NOTES_MERGE_REF',
      ])('Then %s is valid', (referent) => {
        // Arrange
        const sut = isValidSymrefReferent;

        // Act
        const result = sut(referent);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a referent git flags', () => {
    describe('When isValidSymrefReferent runs', () => {
      it.each([
        'foo',
        'main',
        'refs',
        'FETCH_HEAD',
        'MERGE_HEAD',
        'FOO1_HEAD',
        'Foo_HEAD',
        'refs/heads/x.lock',
        'refs/heads/',
        'refs/heads/.x',
        'refs/heads/a b',
        'refs/heads/ma*n',
        '@',
        '',
        'refs/heads/x..y',
        'x..y',
        'refs/heads/main\nextra',
      ])('Then "%s" is invalid', (referent) => {
        // Arrange
        const sut = isValidSymrefReferent;

        // Act
        const result = sut(referent);

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});

describe('isOutsideRefsNamespace', () => {
  describe('Given a referent that is neither a root ref nor under refs/', () => {
    describe('When isOutsideRefsNamespace runs', () => {
      it.each(['foo/bar', 'main', 'FETCH_HEAD', 'FOO1_HEAD', ''])('Then "%s" is outside', (r) => {
        // Arrange
        const sut = isOutsideRefsNamespace;

        // Act
        const result = sut(r);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a root ref or a refs/ path', () => {
    describe('When isOutsideRefsNamespace runs', () => {
      it.each(['HEAD', 'ORIG_HEAD', 'AUTO_MERGE', 'refs/foo', 'refs/heads/main'])(
        'Then %s is inside',
        (r) => {
          // Arrange
          const sut = isOutsideRefsNamespace;

          // Act
          const result = sut(r);

          // Assert
          expect(result).toBe(false);
        },
      );
    });
  });
});
