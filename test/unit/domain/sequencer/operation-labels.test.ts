import { describe, expect, it } from 'vitest';
import {
  CHERRY_PICK,
  CHERRY_PICK_ABORT,
  CHERRY_PICK_CONTINUE,
  CHERRY_PICK_SKIP,
  MERGE,
  MERGE_ABORT,
  PENDING_OPERATIONS,
  REBASE,
  REVERT,
  REVERT_ABORT,
  REVERT_CONTINUE,
  REVERT_SKIP,
} from '../../../../src/domain/sequencer/operation-labels.js';

describe('Given the git operation-label vocabulary', () => {
  describe('When reading the pending-operation set', () => {
    it('Then PENDING_OPERATIONS lists merge, rebase, cherry-pick, revert in order', () => {
      // Arrange / Act / Assert
      expect(PENDING_OPERATIONS).toEqual(['merge', 'rebase', 'cherry-pick', 'revert']);
    });
  });

  describe('When reading the base operation names', () => {
    it.each([
      ['MERGE', MERGE, 'merge'],
      ['REBASE', REBASE, 'rebase'],
      ['CHERRY_PICK', CHERRY_PICK, 'cherry-pick'],
      ['REVERT', REVERT, 'revert'],
    ])('Then %s is the %s operation label', (_name, sut, expected) => {
      // Arrange / Act / Assert
      expect(sut).toBe(expected);
    });
  });

  describe('When reading the CLI-flavored refusal labels', () => {
    it.each([
      ['MERGE_ABORT', MERGE_ABORT, 'merge --abort'],
      ['CHERRY_PICK_CONTINUE', CHERRY_PICK_CONTINUE, 'cherry-pick --continue'],
      ['CHERRY_PICK_SKIP', CHERRY_PICK_SKIP, 'cherry-pick --skip'],
      ['CHERRY_PICK_ABORT', CHERRY_PICK_ABORT, 'cherry-pick --abort'],
      ['REVERT_CONTINUE', REVERT_CONTINUE, 'revert --continue'],
      ['REVERT_SKIP', REVERT_SKIP, 'revert --skip'],
      ['REVERT_ABORT', REVERT_ABORT, 'revert --abort'],
    ])('Then %s is the %s label', (_name, sut, expected) => {
      // Arrange / Act / Assert
      expect(sut).toBe(expected);
    });
  });
});
