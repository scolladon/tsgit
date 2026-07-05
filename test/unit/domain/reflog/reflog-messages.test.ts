import { describe, expect, it } from 'vitest';
import * as sut from '../../../../src/domain/reflog/reflog-messages.js';

describe('Given the reflog message builders', () => {
  describe('When building commit reflog lines', () => {
    it('Then commitInitialReflog prefixes with "commit (initial): "', () => {
      // Arrange / Act / Assert
      expect(sut.commitInitialReflog('add readme')).toBe('commit (initial): add readme');
    });

    it('Then commitMergeReflog prefixes with "commit (merge): "', () => {
      expect(sut.commitMergeReflog('merge topic')).toBe('commit (merge): merge topic');
    });

    it('Then commitCherryPickReflog prefixes with "commit (cherry-pick): "', () => {
      expect(sut.commitCherryPickReflog('pick it')).toBe('commit (cherry-pick): pick it');
    });

    it('Then commitReflog prefixes with "commit: "', () => {
      expect(sut.commitReflog('do work')).toBe('commit: do work');
    });
  });

  describe('When building branch reflog lines', () => {
    it('Then branchCreatedFrom renders "branch: Created from <start-point>"', () => {
      expect(sut.branchCreatedFrom('main')).toBe('branch: Created from main');
    });

    it('Then branchRenamed renders "branch: renamed <from> to <to>"', () => {
      expect(sut.branchRenamed('old', 'new')).toBe('branch: renamed old to new');
    });
  });

  describe('When building reset, clone and fetch reflog lines', () => {
    it('Then resetMovingTo renders "reset: moving to <target>"', () => {
      expect(sut.resetMovingTo('abc123')).toBe('reset: moving to abc123');
    });

    it('Then resetMovingTo with HEAD renders "reset: moving to HEAD"', () => {
      expect(sut.resetMovingTo('HEAD')).toBe('reset: moving to HEAD');
    });

    it('Then cloneFrom renders "clone: from <url>"', () => {
      expect(sut.cloneFrom('https://example.test/repo.git')).toBe(
        'clone: from https://example.test/repo.git',
      );
    });

    it('Then fetchStoringHead renders "fetch <remote>: storing head"', () => {
      expect(sut.fetchStoringHead('origin')).toBe('fetch origin: storing head');
    });
  });

  describe('When reading the static push reflog label', () => {
    it('Then PUSH_UPDATE is "update by push"', () => {
      expect(sut.PUSH_UPDATE).toBe('update by push');
    });
  });
});
