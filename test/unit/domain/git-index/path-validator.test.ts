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
          label: 'throws INVALID_INDEX_ENTRY with the NUL byte reason',
          path: `a${String.fromCharCode(0x00)}b`,
          offset: 5,
          reason: 'NUL byte rejected',
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

  describe('Given a path carrying a byte git 2.55 stages but a stricter validator once rejected', () => {
    describe('When validated', () => {
      it.each([
        { label: 'a literal backslash', path: 'src\\evil' },
        {
          label: 'a C0 control below the former 0x20 cutoff (SOH, U+0001)',
          path: `a${String.fromCharCode(0x01)}b`,
        },
        { label: 'a TAB (U+0009)', path: `a${String.fromCharCode(0x09)}b` },
        { label: 'a newline (U+000A)', path: `a${String.fromCharCode(0x0a)}b` },
        { label: 'a C1 control (NEL, U+0085)', path: `a${String.fromCharCode(0x85)}b` },
        {
          label: 'the C1 upper bound the former guard used (U+009F)',
          path: `a${String.fromCharCode(0x9f)}b`,
        },
        {
          label: 'a code point just above the former C1 range (U+00A0)',
          path: `a${String.fromCharCode(0xa0)}b`,
        },
        { label: 'DEL (U+007F)', path: `a${String.fromCharCode(0x7f)}b` },
        { label: 'ALM (U+061C)', path: `a${String.fromCharCode(0x061c)}b` },
        { label: 'LRM (U+200E)', path: `a${String.fromCharCode(0x200e)}b` },
        { label: 'RLM (U+200F)', path: `a${String.fromCharCode(0x200f)}b` },
        { label: 'LRE (U+202A)', path: `a${String.fromCharCode(0x202a)}b` },
        { label: 'RLO (U+202E)', path: `a${String.fromCharCode(0x202e)}b` },
        { label: 'LRI (U+2066)', path: `a${String.fromCharCode(0x2066)}b` },
        { label: 'PDI (U+2069)', path: `a${String.fromCharCode(0x2069)}b` },
      ])('Then $label does not throw', ({ path }) => {
        // Arrange & Act + Assert — pinned against real git 2.55 (`update-index
        // --add --cacheinfo` and a real `git add` of an on-disk file); every
        // one of these is POSIX-legal to git and must round-trip through
        // tsgit's index parse/write boundary identically.
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
