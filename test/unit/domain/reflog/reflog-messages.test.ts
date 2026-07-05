import { describe, expect, it } from 'vitest';
import * as sut from '../../../../src/domain/reflog/reflog-messages.js';

describe('Given the reflog message builders', () => {
  describe('When building commit reflog lines', () => {
    it('Then commitInitialReflog prefixes with "commit (initial): "', () => {
      // Arrange / Act / Assert
      expect(sut.commitInitialReflog('add readme')).toBe('commit (initial): add readme');
    });

    it('Then commitMergeReflog prefixes with "commit (merge): "', () => {
      // Arrange / Act / Assert
      expect(sut.commitMergeReflog('merge topic')).toBe('commit (merge): merge topic');
    });

    it('Then commitCherryPickReflog prefixes with "commit (cherry-pick): "', () => {
      // Arrange / Act / Assert
      expect(sut.commitCherryPickReflog('pick it')).toBe('commit (cherry-pick): pick it');
    });

    it('Then commitReflog prefixes with "commit: "', () => {
      // Arrange / Act / Assert
      expect(sut.commitReflog('do work')).toBe('commit: do work');
    });
  });

  describe('When building branch reflog lines', () => {
    it('Then branchCreatedFrom renders "branch: Created from <start-point>"', () => {
      // Arrange / Act / Assert
      expect(sut.branchCreatedFrom('main')).toBe('branch: Created from main');
    });

    it('Then branchRenamed renders "branch: renamed <from> to <to>"', () => {
      // Arrange / Act / Assert
      expect(sut.branchRenamed('old', 'new')).toBe('branch: renamed old to new');
    });
  });

  describe('When building reset, clone and fetch reflog lines', () => {
    it('Then resetMovingTo renders "reset: moving to <target>"', () => {
      // Arrange / Act / Assert
      expect(sut.resetMovingTo('abc123')).toBe('reset: moving to abc123');
    });

    it('Then resetMovingTo with HEAD renders "reset: moving to HEAD"', () => {
      // Arrange / Act / Assert
      expect(sut.resetMovingTo('HEAD')).toBe('reset: moving to HEAD');
    });

    it('Then cloneFrom renders "clone: from <url>"', () => {
      // Arrange / Act / Assert
      expect(sut.cloneFrom('https://example.test/repo.git')).toBe(
        'clone: from https://example.test/repo.git',
      );
    });

    it('Then fetchStoringHead renders "fetch <remote>: storing head"', () => {
      // Arrange / Act / Assert
      expect(sut.fetchStoringHead('origin')).toBe('fetch origin: storing head');
    });
  });

  describe('When reading the static push reflog label', () => {
    it('Then PUSH_UPDATE is "update by push"', () => {
      // Arrange / Act / Assert
      expect(sut.PUSH_UPDATE).toBe('update by push');
    });
  });

  describe('When building cherry-pick and revert reflog lines', () => {
    it('Then cherryPickReflog renders "cherry-pick: <subject>"', () => {
      // Arrange / Act / Assert
      expect(sut.cherryPickReflog('port fix')).toBe('cherry-pick: port fix');
    });

    it('Then revertReflog renders "revert: <subject>"', () => {
      // Arrange / Act / Assert
      expect(sut.revertReflog('undo it')).toBe('revert: undo it');
    });
  });

  describe('When building rebase reflog lines', () => {
    it('Then rebaseStartCheckout renders "rebase (start): checkout <onto>"', () => {
      // Arrange / Act / Assert
      expect(sut.rebaseStartCheckout('main')).toBe('rebase (start): checkout main');
    });

    it('Then rebaseActionReflog renders "rebase (<action>): <subject>" for a runtime action', () => {
      // Arrange / Act / Assert
      expect(sut.rebaseActionReflog('squash', 'fold it')).toBe('rebase (squash): fold it');
    });

    it('Then rebasePickReflog renders "rebase (pick): <subject>"', () => {
      // Arrange / Act / Assert
      expect(sut.rebasePickReflog('a step')).toBe('rebase (pick): a step');
    });

    it('Then rebaseEditReflog renders "rebase (edit): <subject>"', () => {
      // Arrange / Act / Assert
      expect(sut.rebaseEditReflog('an edit')).toBe('rebase (edit): an edit');
    });

    it('Then rebaseRewordReflog renders "rebase (reword): <subject>"', () => {
      // Arrange / Act / Assert
      expect(sut.rebaseRewordReflog('a reword')).toBe('rebase (reword): a reword');
    });

    it('Then rebaseContinueReflog renders "rebase (continue): <subject>"', () => {
      // Arrange / Act / Assert
      expect(sut.rebaseContinueReflog('resumed')).toBe('rebase (continue): resumed');
    });

    it('Then rebaseFinishOnto renders "rebase (finish): <branch> onto <onto>"', () => {
      // Arrange / Act / Assert
      expect(sut.rebaseFinishOnto('refs/heads/topic', 'abc123')).toBe(
        'rebase (finish): refs/heads/topic onto abc123',
      );
    });

    it('Then rebaseFinishReturningTo renders "rebase (finish): returning to <branch>"', () => {
      // Arrange / Act / Assert
      expect(sut.rebaseFinishReturningTo('refs/heads/topic')).toBe(
        'rebase (finish): returning to refs/heads/topic',
      );
    });

    it('Then rebaseAbortReturningTo renders "rebase (abort): returning to <target>"', () => {
      // Arrange / Act / Assert
      expect(sut.rebaseAbortReturningTo('abc123')).toBe('rebase (abort): returning to abc123');
    });

    it('Then REBASE_FAST_FORWARD is "rebase: fast-forward"', () => {
      // Arrange / Act / Assert
      expect(sut.REBASE_FAST_FORWARD).toBe('rebase: fast-forward');
    });
  });
});
