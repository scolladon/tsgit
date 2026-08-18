import { describe, expect, it } from 'vitest';

import { layoutRootsOf } from '../../../src/repository/layout-roots.js';

describe('layoutRootsOf', () => {
  describe('Given a normal repo with no commonDir (gitDir under workDir)', () => {
    describe('When layoutRootsOf runs', () => {
      it('Then it minimises to the single workDir root', () => {
        // Arrange
        const layout = { workDir: '/r', gitDir: '/r/.git', bare: false };

        // Act
        const result = layoutRootsOf(layout);

        // Assert
        expect(result).toStrictEqual(['/r']);
      });
    });
  });

  describe('Given a bare repo with no workDir key at all', () => {
    describe('When layoutRootsOf runs', () => {
      it('Then the root set starts at gitDir, not an absent workDir', () => {
        // Arrange — `workDir` omitted entirely (exactOptionalPropertyTypes),
        // the shape `resolveLayout` produces for a bare repository.
        const layout = { gitDir: '/bare.git', bare: true };

        // Act
        const result = layoutRootsOf(layout);

        // Assert
        expect(result).toStrictEqual(['/bare.git']);
      });
    });
  });

  describe('Given the main worktree of a bare repo (workDir === gitDir, no commonDir)', () => {
    describe('When layoutRootsOf runs', () => {
      it('Then it collapses to the single shared root', () => {
        // Arrange
        const layout = { workDir: '/bare.git', gitDir: '/bare.git', bare: true };

        // Act
        const result = layoutRootsOf(layout);

        // Assert
        expect(result).toStrictEqual(['/bare.git']);
      });
    });
  });

  describe('Given a linked worktree whose admin gitDir lives under the common dir', () => {
    describe('When layoutRootsOf runs', () => {
      it('Then it drops the gitDir root and keeps workDir + commonDir', () => {
        // Arrange
        const layout = {
          workDir: '/wt',
          gitDir: '/main/.git/worktrees/wt',
          bare: false,
          commonDir: '/main/.git',
        };

        // Act
        const result = layoutRootsOf(layout);

        // Assert — workDir stays first (the guard's hot path), gitDir is
        // dropped as redundant with commonDir.
        expect(result).toStrictEqual(['/wt', '/main/.git']);
      });
    });
  });

  describe('Given a hand-written commonDir in an unrelated subtree', () => {
    describe('When layoutRootsOf runs', () => {
      it('Then it retains all three roots', () => {
        // Arrange — none of workDir, gitDir, commonDir contains another.
        const layout = {
          workDir: '/repo',
          gitDir: '/elsewhere/admin',
          bare: false,
          commonDir: '/other/common',
        };

        // Act
        const result = layoutRootsOf(layout);

        // Assert
        expect(result).toStrictEqual(['/repo', '/elsewhere/admin', '/other/common']);
      });
    });
  });

  describe('Given gitDir and commonDir are the identical string (submodule / separate-git-dir shape)', () => {
    describe('When layoutRootsOf runs', () => {
      it('Then the duplicate is deduped before containment is even considered', () => {
        // Arrange — workDir is unrelated to the shared admin dir, so both
        // survive as exactly two entries despite three input candidates.
        const layout = {
          workDir: '/repo',
          gitDir: '/submodule/.git/modules/sub',
          bare: false,
          commonDir: '/submodule/.git/modules/sub',
        };

        // Act
        const result = layoutRootsOf(layout);

        // Assert
        expect(result).toStrictEqual(['/repo', '/submodule/.git/modules/sub']);
      });
    });
  });

  describe('Given a commonDir that sorts alphabetically before workDir', () => {
    describe('When layoutRootsOf runs', () => {
      it('Then first-seen order is preserved rather than re-sorted', () => {
        // Arrange — gitDir lives under commonDir (dropped); commonDir's string
        // value would sort before workDir's, proving the survivors keep input
        // order instead of lexical order.
        const layout = {
          workDir: '/z-repo',
          gitDir: '/a-main/.git/worktrees/wt',
          bare: false,
          commonDir: '/a-main/.git',
        };

        // Act
        const result = layoutRootsOf(layout);

        // Assert
        expect(result).toStrictEqual(['/z-repo', '/a-main/.git']);
      });
    });
  });
});
