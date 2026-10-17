import { describe, expect, it } from 'vitest';

import { validateMergeWritePaths } from '../../../../../src/application/primitives/internal/validate-merge-write-paths.js';
import { TsgitError } from '../../../../../src/domain/error.js';
import {
  posixIndexPathRules,
  windowsIndexPathRules,
} from '../../../../../src/domain/git-index/path-validator.js';
import type { MergeConflict, MergeOutcome } from '../../../../../src/domain/merge/index.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/index.js';

const DUMMY_OID = 'a'.repeat(40) as ObjectId;

const catchError = (fn: () => void): unknown => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err;
  }
};

describe('Given a changed clean outcome at a hostile path', () => {
  describe('When validateMergeWritePaths runs', () => {
    it('Then it throws INVALID_INDEX_ENTRY before any write, never silently skipping a touched path', () => {
      // Arrange — the outcome's path IS in `changed` (it will actually be
      // written), so the whole-set gate must inspect it, not skip it.
      const outcome: MergeOutcome = {
        status: 'resolved-known',
        path: '..' as FilePath,
        id: DUMMY_OID,
        mode: FILE_MODE.REGULAR,
      };
      const sut = validateMergeWritePaths;

      // Act
      const caught = catchError(() =>
        sut(posixIndexPathRules, [outcome], [], new Set([outcome.path])),
      );

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      expect(data).toEqual({
        code: 'INVALID_INDEX_ENTRY',
        offset: -1,
        reason: "'..' segment rejected",
      });
    });
  });
});

describe('Given a changed clean outcome NOT in the changed set', () => {
  describe('When validateMergeWritePaths runs', () => {
    it('Then it is skipped and never validated', () => {
      // Arrange — a hostile path that will NOT actually be written (absent
      // from `changed`) must not be inspected at all.
      const outcome: MergeOutcome = {
        status: 'resolved-known',
        path: '..' as FilePath,
        id: DUMMY_OID,
        mode: FILE_MODE.REGULAR,
      };
      const sut = validateMergeWritePaths;

      // Act & Assert
      expect(() => sut(posixIndexPathRules, [outcome], [], new Set())).not.toThrow();
    });
  });
});

describe('Given a distinct-types conflict at ".gitmodules" where ours is a symlink and theirs is regular', () => {
  describe('When validateMergeWritePaths runs', () => {
    it('Then it throws INVALID_INDEX_ENTRY with the gitmodules-not-regular reason, picking ours over theirs', () => {
      // Arrange — mergedMode is absent (only `content` conflicts carry one);
      // the mode-selection chain must fall back to ours (SYMLINK), not theirs.
      const conflict: MergeConflict = {
        type: 'distinct-types',
        path: '.gitmodules' as FilePath,
        ourId: DUMMY_OID,
        ourMode: FILE_MODE.SYMLINK,
        ourPath: '.gitmodules' as FilePath,
        theirId: DUMMY_OID,
        theirMode: FILE_MODE.REGULAR,
        theirPath: '.gitmodules~side' as FilePath,
      };
      const sut = validateMergeWritePaths;

      // Act
      const caught = catchError(() => sut(posixIndexPathRules, [], [conflict], new Set()));

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      expect(data).toEqual({
        code: 'INVALID_INDEX_ENTRY',
        offset: -1,
        reason: "'.gitmodules' must not be a symlink",
      });
    });
  });
});

describe('Given a changed clean outcome at an escaped path forming an HFS .git alias', () => {
  describe('When validateMergeWritePaths runs', () => {
    it('Then it throws INVALID_INDEX_ENTRY with the HFS reason', () => {
      // Arrange
      const outcome: MergeOutcome = {
        status: 'resolved-known',
        path: '.git\uDCFF/x' as FilePath,
        id: DUMMY_OID,
        mode: FILE_MODE.REGULAR,
      };
      const sut = validateMergeWritePaths;

      // Act
      const caught = catchError(() =>
        sut(posixIndexPathRules, [outcome], [], new Set([outcome.path])),
      );

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data).toEqual({
        code: 'INVALID_INDEX_ENTRY',
        offset: -1,
        reason: "'.git' HFS+ ignorable-codepoint alias rejected",
      });
    });
  });
});

describe('Given a file-directory conflict whose moved path is an NTFS short name of .git', () => {
  describe.each([['ourPath'], ['theirPath'], ['basePath']] as const)(
    'When the moved path is carried in %s',
    (field) => {
      it('Then validateMergeWritePaths throws INVALID_INDEX_ENTRY with the NTFS reason', () => {
        // Arrange
        const conflict: MergeConflict = {
          type: 'file-directory',
          path: 'git' as FilePath,
          ourId: DUMMY_OID,
          ourMode: FILE_MODE.REGULAR,
          [field]: 'git~1' as FilePath,
        };
        const sut = validateMergeWritePaths;

        // Act
        const caught = catchError(() => sut(posixIndexPathRules, [], [conflict], new Set()));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'INVALID_INDEX_ENTRY',
          offset: -1,
          reason: "'git~1' NTFS short name rejected",
        });
      });
    },
  );
});

describe('Given a distinct-types conflict whose renamed side is an NTFS short name of .git', () => {
  describe('When validateMergeWritePaths runs', () => {
    it('Then it throws INVALID_INDEX_ENTRY with the NTFS reason', () => {
      // Arrange
      const conflict: MergeConflict = {
        type: 'distinct-types',
        path: 'git' as FilePath,
        ourId: DUMMY_OID,
        ourMode: FILE_MODE.REGULAR,
        ourPath: 'git' as FilePath,
        theirId: DUMMY_OID,
        theirMode: FILE_MODE.SYMLINK,
        theirPath: 'git~1' as FilePath,
      };
      const sut = validateMergeWritePaths;

      // Act
      const caught = catchError(() => sut(posixIndexPathRules, [], [conflict], new Set()));

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data).toEqual({
        code: 'INVALID_INDEX_ENTRY',
        offset: -1,
        reason: "'git~1' NTFS short name rejected",
      });
    });
  });
});

describe('Given a distinct-types conflict at ".gitmodules" where ours is regular and theirs is a symlink', () => {
  describe('When validateMergeWritePaths runs', () => {
    it('Then it throws because theirs is written as a symlink at ".gitmodules"', () => {
      // Arrange
      const conflict: MergeConflict = {
        type: 'distinct-types',
        path: '.gitmodules' as FilePath,
        ourId: DUMMY_OID,
        ourMode: FILE_MODE.REGULAR,
        ourPath: '.gitmodules~HEAD' as FilePath,
        theirId: DUMMY_OID,
        theirMode: FILE_MODE.SYMLINK,
        theirPath: '.gitmodules' as FilePath,
      };
      const sut = validateMergeWritePaths;

      // Act
      const caught = catchError(() => sut(posixIndexPathRules, [], [conflict], new Set()));

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data).toEqual({
        code: 'INVALID_INDEX_ENTRY',
        offset: -1,
        reason: "'.gitmodules' must not be a symlink",
      });
    });
  });
});

describe('Given a distinct-types conflict where ours is a symlink "gitmod" and theirs is a regular file moved to "gitmod~1"', () => {
  describe('When validateMergeWritePaths runs', () => {
    it('Then it accepts it because the moved path is written as a regular file', () => {
      // Arrange
      const conflict: MergeConflict = {
        type: 'distinct-types',
        path: 'gitmod' as FilePath,
        ourId: DUMMY_OID,
        ourMode: FILE_MODE.SYMLINK,
        ourPath: 'gitmod' as FilePath,
        theirId: DUMMY_OID,
        theirMode: FILE_MODE.REGULAR,
        theirPath: 'gitmod~1' as FilePath,
      };
      const sut = validateMergeWritePaths;

      // Act & Assert
      expect(() => sut(posixIndexPathRules, [], [conflict], new Set())).not.toThrow();
    });
  });
});

describe('Given a file-directory conflict whose theirs symlink moves to "gitmod~1"', () => {
  describe('When validateMergeWritePaths runs', () => {
    it('Then it throws because the moved path is written as a symlink', () => {
      // Arrange
      const conflict: MergeConflict = {
        type: 'file-directory',
        path: 'gitmod' as FilePath,
        theirId: DUMMY_OID,
        theirMode: FILE_MODE.SYMLINK,
        theirPath: 'gitmod~1' as FilePath,
      };
      const sut = validateMergeWritePaths;

      // Act
      const caught = catchError(() => sut(posixIndexPathRules, [], [conflict], new Set()));

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data).toEqual({
        code: 'INVALID_INDEX_ENTRY',
        offset: -1,
        reason: "'.gitmodules' must not be a symlink",
      });
    });
  });
});

describe('Given a modify-delete conflict at ".gitmodules" where ours is a symlink and theirs is deleted', () => {
  describe('When validateMergeWritePaths runs', () => {
    it('Then it throws because ours is written as a symlink at ".gitmodules"', () => {
      // Arrange — no merged mode and no theirs mode: ours alone decides.
      const conflict: MergeConflict = {
        type: 'modify-delete',
        path: '.gitmodules' as FilePath,
        ourId: DUMMY_OID,
        ourMode: FILE_MODE.SYMLINK,
      };
      const sut = validateMergeWritePaths;

      // Act
      const caught = catchError(() => sut(posixIndexPathRules, [], [conflict], new Set()));

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data).toEqual({
        code: 'INVALID_INDEX_ENTRY',
        offset: -1,
        reason: "'.gitmodules' must not be a symlink",
      });
    });
  });
});

describe('Given a content conflict at ".gitmodules" whose merged mode is a symlink and theirs is regular', () => {
  describe('When validateMergeWritePaths runs', () => {
    it('Then it throws because the merged mode, not theirs, is written', () => {
      // Arrange
      const conflict: MergeConflict = {
        type: 'content',
        path: '.gitmodules' as FilePath,
        ourId: DUMMY_OID,
        ourMode: FILE_MODE.SYMLINK,
        theirId: DUMMY_OID,
        theirMode: FILE_MODE.REGULAR,
        mergedMode: FILE_MODE.SYMLINK,
      };
      const sut = validateMergeWritePaths;

      // Act
      const caught = catchError(() => sut(posixIndexPathRules, [], [conflict], new Set()));

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data).toEqual({
        code: 'INVALID_INDEX_ENTRY',
        offset: -1,
        reason: "'.gitmodules' must not be a symlink",
      });
    });
  });
});

describe('Given a distinct-types conflict at ".gitmodules" where ours is a symlink moved to ".gitmodules~HEAD" and theirs is regular', () => {
  describe('When validateMergeWritePaths runs', () => {
    it('Then it accepts it because ".gitmodules" itself is written as a regular file', () => {
      // Arrange
      const conflict: MergeConflict = {
        type: 'distinct-types',
        path: '.gitmodules' as FilePath,
        ourId: DUMMY_OID,
        ourMode: FILE_MODE.SYMLINK,
        ourPath: '.gitmodules~HEAD' as FilePath,
        theirId: DUMMY_OID,
        theirMode: FILE_MODE.REGULAR,
        theirPath: '.gitmodules' as FilePath,
      };
      const sut = validateMergeWritePaths;

      // Act & Assert
      expect(() => sut(posixIndexPathRules, [], [conflict], new Set())).not.toThrow();
    });
  });
});

describe('Given a backslash path at each write the gate checks', () => {
  const BACKSLASH_REASON = 'backslash rejected under Windows path syntax';
  const backslash = 'x\\y' as FilePath;
  const resolvedKnown: MergeOutcome = {
    status: 'resolved-known',
    path: backslash,
    id: DUMMY_OID,
    mode: FILE_MODE.REGULAR,
  };
  const resolvedDeleted: MergeOutcome = { status: 'resolved-deleted', path: backslash };
  const modifyDelete = {
    type: 'modify-delete',
    path: backslash,
    ourId: DUMMY_OID,
    ourMode: FILE_MODE.REGULAR,
  } as MergeConflict;
  const fileDirectory = {
    type: 'file-directory',
    path: backslash,
    theirId: DUMMY_OID,
    theirMode: FILE_MODE.REGULAR,
  } as MergeConflict;
  const distinctTypes: MergeConflict = {
    type: 'distinct-types',
    path: 'p' as FilePath,
    ourPath: 'p' as FilePath,
    ourId: DUMMY_OID,
    ourMode: FILE_MODE.REGULAR,
    theirPath: backslash,
    theirId: DUMMY_OID,
    theirMode: FILE_MODE.SYMLINK,
  };
  const rows: ReadonlyArray<
    readonly [string, ReadonlyArray<MergeOutcome>, ReadonlyArray<MergeConflict>]
  > = [
    ['a resolved-known outcome', [resolvedKnown], []],
    ['a resolved-deleted outcome', [resolvedDeleted], []],
    ['a modify-delete conflict', [], [modifyDelete]],
    ['a file-directory conflict', [], [fileDirectory]],
    ['a distinct-types side path', [], [distinctTypes]],
  ];

  describe.each(rows)(
    'When validateMergeWritePaths runs with the Windows rules on %s',
    (_label, outcomes, conflicts) => {
      it('Then it throws INVALID_INDEX_ENTRY with the backslash reason', () => {
        // Arrange
        const sut = validateMergeWritePaths;

        // Act
        const caught = catchError(() =>
          sut(windowsIndexPathRules, outcomes, conflicts, new Set([backslash])),
        );

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'INVALID_INDEX_ENTRY',
          offset: -1,
          reason: BACKSLASH_REASON,
        });
      });
    },
  );

  describe.each(rows)(
    'When validateMergeWritePaths runs with the POSIX rules on %s',
    (_label, outcomes, conflicts) => {
      it('Then it does not throw', () => {
        // Arrange
        const sut = validateMergeWritePaths;

        // Act
        const act = () => sut(posixIndexPathRules, outcomes, conflicts, new Set([backslash]));

        // Assert
        expect(act).not.toThrow();
      });
    },
  );
});
