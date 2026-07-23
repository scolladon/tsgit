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

  describe('Given a path that trips a validation guard', () => {
    describe('When validated', () => {
      it.each([
        {
          label: 'throws INVALID_INDEX_ENTRY with the absolute-path reason',
          path: '/etc/passwd',
          offset: 12,
          reason: 'absolute path rejected',
        },
        {
          label: 'throws INVALID_INDEX_ENTRY with the backslash reason',
          path: 'src\\evil',
          offset: 4,
          reason: 'backslash rejected',
        },
        {
          // 0x1F is the top of the C0 range (code < 0x20).
          label: 'throws INVALID_INDEX_ENTRY with the control reason',
          path: `a${String.fromCharCode(0x1f)}b`,
          offset: 0,
          reason: 'control character rejected',
        },
        {
          // 0x9F is the inclusive upper bound: the guard is `code <= 0x9f`.
          // A `code < 0x9f` mutant would let U+009F through and fail to throw.
          label: 'throws INVALID_INDEX_ENTRY with the control reason',
          path: `a${String.fromCharCode(0x9f)}b`,
          offset: 7,
          reason: 'control character rejected',
        },
        {
          label: 'throws INVALID_INDEX_ENTRY with the bidi reason',
          path: `a${String.fromCharCode(0x202e)}b`,
          offset: 0,
          reason: 'bidi control character rejected',
        },
        {
          label: "throws INVALID_INDEX_ENTRY with the '..' reason",
          path: 'src/../etc',
          offset: 0,
          reason: "'..' segment rejected",
        },
        {
          label: "throws INVALID_INDEX_ENTRY with the '.' reason",
          path: 'src/./file',
          offset: 0,
          reason: "'.' segment rejected",
        },
        {
          label: 'throws INVALID_INDEX_ENTRY with the empty-segment reason',
          path: 'src//file',
          offset: NO_PARSER_OFFSET,
          reason: 'empty segment rejected',
        },
      ])('Then $label', ({ path, offset, reason }) => {
        // Arrange & Act
        const caught = catchError(() => validateIndexPath(path, offset));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data).toEqual({ code: 'INVALID_INDEX_ENTRY', offset, reason });
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
