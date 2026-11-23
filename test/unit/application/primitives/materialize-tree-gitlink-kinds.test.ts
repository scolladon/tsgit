import { describe, expect, it } from 'vitest';
import { materializeTree } from '../../../../src/application/primitives/materialize-tree.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import type { GitIndex, IndexEntry } from '../../../../src/domain/git-index/index.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import type { SparseMatcher } from '../../../../src/domain/sparse/index.js';
import { buildSeededContext } from './fixtures.js';

const GITLINK_ID = '1'.repeat(40) as ObjectId;

const skippedGitlink: IndexEntry = {
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode: FILE_MODE.GITLINK,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id: GITLINK_ID,
  flags: { ...STAGE0_FLAGS, skipWorktree: true },
  path: 'sub' as FilePath,
};

const index: GitIndex = {
  version: 2,
  entries: [skippedGitlink],
  extensions: [],
  trailerSha: new Uint8Array(0),
};

/** A rule that excludes the directory `sub` and nothing else. */
const excludesDirectorySub: SparseMatcher = (path, kind = 'file') =>
  !(path === 'sub' && kind === 'directory');

const arrange = async (refreshedIndex: boolean) => {
  const ctx = await buildSeededContext();
  const tree = await writeTree(ctx, [treeEntry(FILE_MODE.GITLINK, 'sub' as FilePath, GITLINK_ID)]);
  const options = {
    targetTree: tree,
    headTree: tree,
    currentIndex: index,
    sparse: excludesDirectorySub,
    force: false,
    ...(refreshedIndex ? { refreshedIndex } : {}),
  };
  return { ctx, options };
};

const skipWorktreeOf = (entries: ReadonlyArray<IndexEntry>): boolean | undefined =>
  entries.find((entry) => entry.path === 'sub')?.flags.skipWorktree;

describe('materializeTree over a skip-worktree gitlink whose directory is absent', () => {
  describe('Given the index was refreshed before the switch', () => {
    describe('When a directory-only rule excludes the gitlink', () => {
      it('Then it stays skip-worktree, judged a directory', async () => {
        // Arrange
        const { ctx, options } = await arrange(true);
        const sut = materializeTree;

        // Act
        const result = await sut(ctx, options);

        // Assert
        expect(skipWorktreeOf(result.newIndexEntries)).toBe(true);
      });
    });
  });

  describe('Given the index was not refreshed before the switch', () => {
    describe('When a directory-only rule excludes the gitlink', () => {
      it('Then it is judged by what stands at its path, a file that rule leaves in', async () => {
        // Arrange
        const { ctx, options } = await arrange(false);
        const sut = materializeTree;

        // Act
        const result = await sut(ctx, options);

        // Assert
        expect(skipWorktreeOf(result.newIndexEntries)).toBe(false);
      });
    });
  });
});
