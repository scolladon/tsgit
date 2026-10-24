import { describe, expect, it } from 'vitest';

import {
  relativePathBetween,
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
      const result = submoduleGitfile(name, path);
      // Assert
      expect(result).toBe(expected);
    });
  });

  describe('When deriving the module `core.worktree`', () => {
    it.each([
      ['two-segment name equal to path', 'libs/sub', 'libs/sub', '../../../../libs/sub'],
      ['single-segment name, two-segment path', 'custom', 'vendor/x', '../../../vendor/x'],
      ['single-segment name and path', 'a', 'a', '../../../a'],
      ['three-segment name', 'a/b/c', 'p', '../../../../../p'],
    ])(
      'Then %s yields the name-depth-relative worktree pointer',
      (_label, name, path, expected) => {
        // Arrange + Act
        const result = submoduleCoreWorktree(name, path);
        // Assert
        expect(result).toBe(expected);
      },
    );
  });
});

describe('Given a module directory and a working-tree path', () => {
  describe('When deriving the relative path between them', () => {
    it('Then a linked worktree module climbs to the common directory and descends into the worktree', () => {
      // Arrange
      const from = '/r/super/.git/worktrees/wt/modules/sub';
      const to = '/r/wt/sub';

      // Act
      const result = relativePathBetween(from, to);

      // Assert
      expect(result).toBe('../../../../../../wt/sub');
    });

    it.each([
      [
        'linked worktree inside the superproject',
        '/r/.git/worktrees/wt/modules/sub',
        '/r/wt/sub',
        '../../../../../wt/sub',
      ],
      ['main worktree', '/r/.git/modules/sub', '/r/sub', '../../../sub'],
      ['nested name', '/r/.git/modules/a/b', '/r/sub', '../../../../sub'],
      ['nested path', '/r/.git/modules/sub', '/r/x/y', '../../../x/y'],
    ])('Then %s matches the submodule core.worktree shape', (_label, from, to, expected) => {
      // Arrange + Act
      const result = relativePathBetween(from, to);

      // Assert
      expect(result).toBe(expected);
    });

    it('Then the main layout equals submoduleCoreWorktree', () => {
      // Arrange + Act
      const result = relativePathBetween('/r/.git/modules/a/b', '/r/x/y');

      // Assert
      expect(result).toBe(submoduleCoreWorktree('a/b', 'x/y'));
    });
  });
});
