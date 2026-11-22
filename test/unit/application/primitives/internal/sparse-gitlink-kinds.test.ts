import { describe, expect, it, vi } from 'vitest';
import { requireWorkTree } from '../../../../../src/application/primitives/internal/repo-state.js';
import {
  mergeGitlinkKinds,
  skippedGitlinkPaths,
  withGitlinkKinds,
} from '../../../../../src/application/primitives/internal/sparse-gitlink-kinds.js';
import type { IndexEntry } from '../../../../../src/domain/git-index/index.js';
import { STAGE0_FLAGS } from '../../../../../src/domain/git-index/index.js';
import type { MergeOutcome } from '../../../../../src/domain/merge/index.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/index.js';
import type { SparseEntryKind } from '../../../../../src/domain/sparse/index.js';
import { buildSeededContext } from '../fixtures.js';

const path = (p: string): FilePath => p as FilePath;

const gitlink = (p: string, extra: { pathBytes?: Uint8Array } = {}) => ({
  path: path(p),
  mode: FILE_MODE.GITLINK,
  ...extra,
});

/** A matcher that includes a path exactly when it is judged as a directory. */
const directoriesOnly = () =>
  vi.fn((_path: FilePath, kind?: SparseEntryKind) => kind === 'directory');

describe('withGitlinkKinds', () => {
  describe('Given no sparse matcher', () => {
    describe('When asked to judge gitlinks', () => {
      it('Then it answers undefined without reading the work tree', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const lstat = vi.spyOn(ctx.fs, 'lstat');
        const sut = withGitlinkKinds;

        // Act
        const result = await sut(ctx, 'test', undefined, [[gitlink('sub')]]);

        // Assert
        expect(result).toBeUndefined();
        expect(lstat).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a gitlink whose directory is present', () => {
    describe('When its path is judged without a kind', () => {
      it('Then the matcher is asked about a directory', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.mkdir(`${requireWorkTree(ctx, 'test')}/sub`);
        const matcher = directoriesOnly();
        const sut = withGitlinkKinds;

        // Act
        const wrapped = await sut(ctx, 'test', matcher, [[gitlink('sub')]]);
        const result = wrapped?.(path('sub'));

        // Assert
        expect(result).toBe(true);
        expect(matcher).toHaveBeenCalledWith('sub', 'directory');
      });
    });

    describe('When another path is judged', () => {
      it('Then the matcher is asked about a file', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.mkdir(`${requireWorkTree(ctx, 'test')}/sub`);
        const matcher = directoriesOnly();
        const sut = withGitlinkKinds;

        // Act
        const wrapped = await sut(ctx, 'test', matcher, [[gitlink('sub')]]);
        const result = wrapped?.(path('other'));

        // Assert
        expect(result).toBe(false);
        expect(matcher).toHaveBeenCalledWith('other', 'file');
      });
    });

    describe('When its path is judged with an explicit kind', () => {
      it('Then the explicit kind wins', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.mkdir(`${requireWorkTree(ctx, 'test')}/sub`);
        const matcher = directoriesOnly();
        const sut = withGitlinkKinds;

        // Act
        const wrapped = await sut(ctx, 'test', matcher, [[gitlink('sub')]]);
        const result = wrapped?.(path('sub'), 'file');

        // Assert
        expect(result).toBe(false);
        expect(matcher).toHaveBeenCalledWith('sub', 'file');
      });
    });
  });

  describe('Given a gitlink with no directory', () => {
    describe('When the matcher is wrapped', () => {
      it('Then the matcher itself is returned', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const matcher = directoriesOnly();
        const sut = withGitlinkKinds;

        // Act
        const wrapped = await sut(ctx, 'test', matcher, [[gitlink('sub')]]);

        // Assert
        expect(wrapped).toBe(matcher);
      });
    });
  });

  describe('Given a file standing at the path of a gitlink', () => {
    describe('When the matcher is wrapped', () => {
      it('Then the path is not a directory', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.write(`${requireWorkTree(ctx, 'test')}/sub`, new Uint8Array());
        const matcher = directoriesOnly();
        const sut = withGitlinkKinds;

        // Act
        const wrapped = await sut(ctx, 'test', matcher, [[gitlink('sub')]]);

        // Assert
        expect(wrapped).toBe(matcher);
      });
    });
  });

  describe('Given a directory standing at the path of a regular file', () => {
    describe('When the matcher is wrapped', () => {
      it('Then the path is left a file', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.mkdir(`${requireWorkTree(ctx, 'test')}/f`);
        const matcher = directoriesOnly();
        const regular = { path: path('f'), mode: FILE_MODE.REGULAR };
        const sut = withGitlinkKinds;

        // Act
        const wrapped = await sut(ctx, 'test', matcher, [[regular]]);

        // Assert
        expect(wrapped).toBe(matcher);
      });
    });
  });

  describe('Given a lossy gitlink path whose decoded name is a present directory', () => {
    describe('When the matcher is wrapped', () => {
      it('Then it is not probed', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.mkdir(`${requireWorkTree(ctx, 'test')}/sub`);
        const matcher = directoriesOnly();
        const lossy = gitlink('sub', { pathBytes: new Uint8Array([0x73, 0x75, 0x62]) });
        const sut = withGitlinkKinds;

        // Act
        const wrapped = await sut(ctx, 'test', matcher, [[lossy]]);

        // Assert
        expect(wrapped).toBe(matcher);
      });
    });
  });

  describe('Given an assumed directory with nothing at its path', () => {
    describe('When its path is judged', () => {
      it('Then the matcher is asked about a directory', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const matcher = directoriesOnly();
        const sut = withGitlinkKinds;

        // Act
        const wrapped = await sut(ctx, 'test', matcher, [], [path('sub')]);
        const result = wrapped?.(path('sub'));

        // Assert
        expect(result).toBe(true);
      });
    });
  });
});

describe('skippedGitlinkPaths', () => {
  const entry = (p: string, mode: string, skipWorktree: boolean, pathBytes?: Uint8Array) => ({
    path: path(p),
    mode,
    flags: { skipWorktree },
    ...(pathBytes === undefined ? {} : { pathBytes }),
  });

  describe('Given gitlinks and files, with and without the bit, one lossy', () => {
    describe('When listed', () => {
      it('Then only the skip-worktree gitlinks with an exact path remain', () => {
        // Arrange
        const entries = [
          entry('kept', FILE_MODE.GITLINK, true),
          entry('shown', FILE_MODE.GITLINK, false),
          entry('file', FILE_MODE.REGULAR, true),
          entry('lossy', FILE_MODE.GITLINK, true, new Uint8Array([0xff])),
        ];

        // Act
        const result = skippedGitlinkPaths(entries);

        // Assert
        expect(result).toEqual(['kept']);
      });
    });
  });
});

describe('mergeGitlinkKinds', () => {
  const GITLINK_ID = '1'.repeat(40) as ObjectId;
  const skipped = (p: string): IndexEntry =>
    ({
      path: path(p),
      mode: FILE_MODE.GITLINK,
      id: GITLINK_ID,
      flags: { ...STAGE0_FLAGS, skipWorktree: true },
    }) as IndexEntry;
  const enteringGitlink = (p: string): MergeOutcome => ({
    status: 'resolved-known',
    path: path(p),
    id: GITLINK_ID,
    mode: FILE_MODE.GITLINK,
  });
  const deleted = (p: string): MergeOutcome => ({ status: 'resolved-deleted', path: path(p) });

  describe('Given a refreshing operation and a skip-worktree gitlink with no directory', () => {
    describe('When the kinds are taken', () => {
      it('Then the gitlink is assumed and judged a directory', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const matcher = directoriesOnly();
        const sut = mergeGitlinkKinds;

        // Act
        const { judging, assumedDirectories } = await sut(
          ctx,
          matcher,
          [skipped('sub')],
          [deleted('gone')],
          true,
        );

        // Assert
        expect(assumedDirectories).toEqual(['sub']);
        expect(judging?.(path('sub'))).toBe(true);
      });
    });
  });

  describe('Given an operation that does not refresh and the same gitlink', () => {
    describe('When the kinds are taken', () => {
      it('Then nothing is assumed and the matcher is returned as given', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const matcher = directoriesOnly();
        const sut = mergeGitlinkKinds;

        // Act
        const { judging, assumedDirectories } = await sut(
          ctx,
          matcher,
          [skipped('sub')],
          [],
          false,
        );

        // Assert
        expect(assumedDirectories).toEqual([]);
        expect(judging).toBe(matcher);
      });
    });
  });

  describe('Given a gitlink the merge brings whose directory is present', () => {
    describe('When the kinds are taken', () => {
      it('Then it is judged a directory and a deleted path is not probed', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.mkdir(`${requireWorkTree(ctx, 'test')}/sub`);
        const matcher = directoriesOnly();
        const sut = mergeGitlinkKinds;

        // Act
        const { judging } = await sut(
          ctx,
          matcher,
          [],
          [enteringGitlink('sub'), deleted('sub2')],
          false,
        );

        // Assert
        expect(judging?.(path('sub'))).toBe(true);
        expect(judging?.(path('sub2'))).toBe(false);
      });
    });
  });

  describe('Given no sparse matcher', () => {
    describe('When the kinds are taken', () => {
      it('Then there is nothing to judge with', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = mergeGitlinkKinds;

        // Act
        const { judging } = await sut(ctx, undefined, [skipped('sub')], [], true);

        // Assert
        expect(judging).toBeUndefined();
      });
    });
  });
});
