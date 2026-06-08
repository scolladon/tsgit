import { describe, expect, it } from 'vitest';

import {
  submoduleCoreWorktree,
  submoduleGitfile,
} from '../../../../src/domain/submodule/gitlink-path.js';

describe('Given a submodule name and worktree path', () => {
  describe('When deriving the worktree `.git` gitfile', () => {
    it.each([
      [
        'two-segment path equal to name',
        'libs/sub',
        'libs/sub',
        'gitdir: ../../.git/modules/libs/sub',
      ],
      [
        'two-segment path, single-segment name',
        'custom',
        'vendor/x',
        'gitdir: ../../.git/modules/custom',
      ],
      ['single-segment path and name', 'a', 'a', 'gitdir: ../.git/modules/a'],
      ['three-segment path', 'mod', 'a/b/c', 'gitdir: ../../../.git/modules/mod'],
    ])('Then %s yields the path-depth-relative gitdir pointer', (_label, name, path, expected) => {
      // Arrange + Act
      const sut = submoduleGitfile(name, path);
      // Assert
      expect(sut).toBe(expected);
    });
  });

  describe('When deriving the module `core.worktree`', () => {
    it.each([
      ['two-segment name equal to path', 'libs/sub', 'libs/sub', '../../../../libs/sub'],
      ['single-segment name, two-segment path', 'custom', 'vendor/x', '../../../vendor/x'],
      ['single-segment name and path', 'a', 'a', '../../../a'],
      ['three-segment name', 'a/b/c', 'p', '../../../../../p'],
    ])('Then %s yields the name-depth-relative worktree pointer', (_label, name, path, expected) => {
      // Arrange + Act
      const sut = submoduleCoreWorktree(name, path);
      // Assert
      expect(sut).toBe(expected);
    });
  });
});
