import { describe, expect, it } from 'vitest';

import { TsgitError } from '../../../../src/domain/error.js';
import {
  NO_PARSER_OFFSET,
  validateIndexPath,
} from '../../../../src/domain/git-index/path-validator.js';

const catchError = (fn: () => void): unknown => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err;
  }
};

describe('validateIndexPath', () => {
  describe('Given a safe relative path', () => {
    describe('When validated', () => {
      it('Then it does not throw', () => {
        // Arrange
        const path = 'src/domain/file.ts';

        // Act + Assert — must not throw.
        expect(() => validateIndexPath(path, 0)).not.toThrow();
      });
    });
  });

  describe('Given an absolute path with a leading slash', () => {
    describe('When validated', () => {
      it('Then throws INVALID_INDEX_ENTRY with the absolute-path reason', () => {
        // Arrange
        const path = '/etc/passwd';

        // Act
        const caught = catchError(() => validateIndexPath(path, 12));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data).toEqual({
          code: 'INVALID_INDEX_ENTRY',
          offset: 12,
          reason: 'absolute path rejected',
        });
      });
    });
  });

  describe('Given a path containing a backslash', () => {
    describe('When validated', () => {
      it('Then throws INVALID_INDEX_ENTRY with the backslash reason', () => {
        // Arrange
        const path = 'src\\evil';

        // Act
        const caught = catchError(() => validateIndexPath(path, 4));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data).toEqual({
          code: 'INVALID_INDEX_ENTRY',
          offset: 4,
          reason: 'backslash rejected',
        });
      });
    });
  });

  describe('Given a path containing a C0 control character (0x1F)', () => {
    describe('When validated', () => {
      it('Then throws INVALID_INDEX_ENTRY with the control reason', () => {
        // Arrange — 0x1F is the top of the C0 range (code < 0x20).
        const path = `a${String.fromCharCode(0x1f)}b`;

        // Act
        const caught = catchError(() => validateIndexPath(path, 0));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data).toEqual({
          code: 'INVALID_INDEX_ENTRY',
          offset: 0,
          reason: 'control character rejected',
        });
      });
    });
  });

  describe('Given a path containing U+009F (the upper bound of the C1 range)', () => {
    describe('When validated', () => {
      it('Then throws INVALID_INDEX_ENTRY with the control reason', () => {
        // Arrange — 0x9F is the inclusive upper bound: the guard is `code <= 0x9f`.
        // A `code < 0x9f` mutant would let U+009F through and fail to throw.
        const path = `a${String.fromCharCode(0x9f)}b`;

        // Act
        const caught = catchError(() => validateIndexPath(path, 7));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data).toEqual({
          code: 'INVALID_INDEX_ENTRY',
          offset: 7,
          reason: 'control character rejected',
        });
      });
    });
  });

  describe('Given a path containing a code point just above the C1 range (U+00A0)', () => {
    describe('When validated', () => {
      it('Then it does not throw', () => {
        // Arrange — 0xA0 is one past the C1 upper bound and must be allowed; this
        // pins the upper edge so a widened control range would be caught.
        const path = `a${String.fromCharCode(0xa0)}b`;

        // Act + Assert
        expect(() => validateIndexPath(path, 0)).not.toThrow();
      });
    });
  });

  describe('Given a path containing a BIDI override (U+202E)', () => {
    describe('When validated', () => {
      it('Then throws INVALID_INDEX_ENTRY with the bidi reason', () => {
        // Arrange
        const path = `a${String.fromCharCode(0x202e)}b`;

        // Act
        const caught = catchError(() => validateIndexPath(path, 0));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data).toEqual({
          code: 'INVALID_INDEX_ENTRY',
          offset: 0,
          reason: 'bidi control character rejected',
        });
      });
    });
  });

  describe("Given a path with a '..' segment", () => {
    describe('When validated', () => {
      it("Then throws INVALID_INDEX_ENTRY with the '..' reason", () => {
        // Arrange
        const path = 'src/../etc';

        // Act
        const caught = catchError(() => validateIndexPath(path, 0));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data).toEqual({
          code: 'INVALID_INDEX_ENTRY',
          offset: 0,
          reason: "'..' segment rejected",
        });
      });
    });
  });

  describe("Given a path with a '.' segment", () => {
    describe('When validated', () => {
      it("Then throws INVALID_INDEX_ENTRY with the '.' reason", () => {
        // Arrange
        const path = 'src/./file';

        // Act
        const caught = catchError(() => validateIndexPath(path, 0));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data).toEqual({
          code: 'INVALID_INDEX_ENTRY',
          offset: 0,
          reason: "'.' segment rejected",
        });
      });
    });
  });

  describe('Given a path with an empty segment (double slash)', () => {
    describe('When validated', () => {
      it('Then throws INVALID_INDEX_ENTRY with the empty-segment reason', () => {
        // Arrange
        const path = 'src//file';

        // Act
        const caught = catchError(() => validateIndexPath(path, NO_PARSER_OFFSET));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data).toEqual({
          code: 'INVALID_INDEX_ENTRY',
          offset: NO_PARSER_OFFSET,
          reason: 'empty segment rejected',
        });
      });
    });
  });
});

describe('NO_PARSER_OFFSET', () => {
  describe('Given the sentinel', () => {
    describe('When inspected', () => {
      it('Then it is -1', () => {
        // Arrange + Assert
        expect(NO_PARSER_OFFSET).toBe(-1);
      });
    });
  });
});
