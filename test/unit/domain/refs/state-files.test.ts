import { describe, expect, it } from 'vitest';
import * as sut from '../../../../src/domain/refs/state-files.js';

describe('Given the git state-marker filenames', () => {
  describe('When reading the canonical constants', () => {
    it('Then MERGE_HEAD is the merge marker filename', () => {
      // Arrange / Act / Assert
      expect(sut.MERGE_HEAD).toBe('MERGE_HEAD');
    });

    it('Then MERGE_MSG is the merge-message filename', () => {
      expect(sut.MERGE_MSG).toBe('MERGE_MSG');
    });

    it('Then ORIG_HEAD is the original-HEAD filename', () => {
      expect(sut.ORIG_HEAD).toBe('ORIG_HEAD');
    });

    it('Then CHERRY_PICK_HEAD is the cherry-pick marker filename', () => {
      expect(sut.CHERRY_PICK_HEAD).toBe('CHERRY_PICK_HEAD');
    });

    it('Then REVERT_HEAD is the revert marker filename', () => {
      expect(sut.REVERT_HEAD).toBe('REVERT_HEAD');
    });

    it('Then REBASE_HEAD is the rebase marker filename', () => {
      expect(sut.REBASE_HEAD).toBe('REBASE_HEAD');
    });

    it('Then FETCH_HEAD is the fetch marker filename', () => {
      expect(sut.FETCH_HEAD).toBe('FETCH_HEAD');
    });
  });
});
