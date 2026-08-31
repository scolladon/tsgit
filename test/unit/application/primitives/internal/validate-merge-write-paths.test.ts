import { describe, expect, it } from 'vitest';

import { validateMergeWritePaths } from '../../../../../src/application/primitives/internal/validate-merge-write-paths.js';
import { TsgitError } from '../../../../../src/domain/error.js';
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
      const caught = catchError(() => sut([outcome], [], new Set([outcome.path])));

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
      expect(() => sut([outcome], [], new Set())).not.toThrow();
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
        theirId: DUMMY_OID,
        theirMode: FILE_MODE.REGULAR,
      };
      const sut = validateMergeWritePaths;

      // Act
      const caught = catchError(() => sut([], [conflict], new Set()));

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
