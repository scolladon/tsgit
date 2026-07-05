import { describe, expect, it } from 'vitest';
import * as sut from '../../../../src/domain/sequencer/operation-labels.js';

describe('Given the git operation-label vocabulary', () => {
  describe('When reading the pending-operation set', () => {
    it('Then PENDING_OPERATIONS lists merge, rebase, cherry-pick, revert in order', () => {
      // Arrange / Act / Assert
      expect(sut.PENDING_OPERATIONS).toEqual(['merge', 'rebase', 'cherry-pick', 'revert']);
    });
  });

  describe('When reading the base operation names', () => {
    it('Then MERGE is the merge operation label', () => {
      expect(sut.MERGE).toBe('merge');
    });

    it('Then REBASE is the rebase operation label', () => {
      expect(sut.REBASE).toBe('rebase');
    });

    it('Then CHERRY_PICK is the cherry-pick operation label', () => {
      expect(sut.CHERRY_PICK).toBe('cherry-pick');
    });

    it('Then REVERT is the revert operation label', () => {
      expect(sut.REVERT).toBe('revert');
    });
  });

  describe('When reading the CLI-flavored refusal labels', () => {
    it('Then MERGE_ABORT is the merge --abort label', () => {
      expect(sut.MERGE_ABORT).toBe('merge --abort');
    });

    it('Then CHERRY_PICK_CONTINUE is the cherry-pick --continue label', () => {
      expect(sut.CHERRY_PICK_CONTINUE).toBe('cherry-pick --continue');
    });

    it('Then CHERRY_PICK_SKIP is the cherry-pick --skip label', () => {
      expect(sut.CHERRY_PICK_SKIP).toBe('cherry-pick --skip');
    });

    it('Then CHERRY_PICK_ABORT is the cherry-pick --abort label', () => {
      expect(sut.CHERRY_PICK_ABORT).toBe('cherry-pick --abort');
    });

    it('Then REVERT_CONTINUE is the revert --continue label', () => {
      expect(sut.REVERT_CONTINUE).toBe('revert --continue');
    });

    it('Then REVERT_SKIP is the revert --skip label', () => {
      expect(sut.REVERT_SKIP).toBe('revert --skip');
    });

    it('Then REVERT_ABORT is the revert --abort label', () => {
      expect(sut.REVERT_ABORT).toBe('revert --abort');
    });
  });
});
