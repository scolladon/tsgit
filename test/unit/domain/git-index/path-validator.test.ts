import { describe, expect, it } from 'vitest';

import { TsgitError } from '../../../../src/domain/error.js';
import {
  NO_PARSER_OFFSET,
  validateIndexPath,
} from '../../../../src/domain/git-index/path-validator.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';

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

        // Assert
        expect(() => validateIndexPath(path, 0, FILE_MODE.REGULAR)).not.toThrow();
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
        {
          label: "throws INVALID_INDEX_ENTRY with the '.git' alias reason",
          path: '.git',
          offset: 0,
          reason: "'.git' component rejected",
        },
        {
          label: "throws INVALID_INDEX_ENTRY with the '.git' alias reason for a nested component",
          path: 'a/.GIT/config',
          offset: 0,
          reason: "'.git' component rejected",
        },
        {
          label: 'throws INVALID_INDEX_ENTRY with the NTFS short-name reason',
          path: 'git~1/config',
          offset: 0,
          reason: "'git~1' NTFS short name rejected",
        },
        {
          label: 'throws INVALID_INDEX_ENTRY with the NTFS alternate-data-stream reason',
          path: '.git:$INDEX_ALLOCATION',
          offset: 0,
          reason: "'.git' NTFS alternate data stream rejected",
        },
        {
          label: 'throws INVALID_INDEX_ENTRY with the HFS+ ignorable-codepoint reason',
          path: `.g${String.fromCodePoint(0x200c)}it`,
          offset: 0,
          reason: "'.git' HFS+ ignorable-codepoint alias rejected",
        },
      ])('Then $label', ({ path, offset, reason }) => {
        // Arrange & Act
        const caught = catchError(() => validateIndexPath(path, offset, FILE_MODE.REGULAR));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data).toEqual({ code: 'INVALID_INDEX_ENTRY', offset, reason });
      });
    });
  });

  describe('Given a `.gitmodules` leaf entry with symlink mode', () => {
    describe('When validated', () => {
      it('Then throws INVALID_INDEX_ENTRY with the gitmodules-not-regular reason', () => {
        // Arrange & Act
        const caught = catchError(() => validateIndexPath('.gitmodules', 3, FILE_MODE.SYMLINK));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data).toEqual({
          code: 'INVALID_INDEX_ENTRY',
          offset: 3,
          reason: "'.gitmodules' must not be a symlink",
        });
      });
    });
  });

  describe('Given a `.gitmodules` leaf entry with regular mode', () => {
    describe('When validated', () => {
      it('Then it does not throw', () => {
        // Arrange & Act + Assert
        expect(() => validateIndexPath('.gitmodules', 0, FILE_MODE.REGULAR)).not.toThrow();
      });
    });
  });

  describe('Given a path containing a code point just above the C1 range (U+00A0)', () => {
    describe('When validated', () => {
      it('Then it does not throw', () => {
        // Arrange — 0xA0 is one past the C1 upper bound and must be allowed; this
        // pins the upper edge so a widened control range would be caught.
        const path = `a${String.fromCharCode(0xa0)}b`;

        // Assert
        expect(() => validateIndexPath(path, 0, FILE_MODE.REGULAR)).not.toThrow();
      });
    });
  });

  describe('Given a path with an alias component earlier than a shape violation', () => {
    describe('When validated', () => {
      it("Then it rejects on the earlier '.git' alias, not the later '..' segment", () => {
        // Arrange — left-to-right, first-component-wins: '.git' at index 0 must
        // win over the '..' at index 1, mirroring git's single incremental
        // left-to-right walk over verify_path.
        const path = '.git/../evil';

        // Act
        const caught = catchError(() => validateIndexPath(path, 0, FILE_MODE.REGULAR));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data).toEqual({
          code: 'INVALID_INDEX_ENTRY',
          offset: 0,
          reason: "'.git' component rejected",
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
