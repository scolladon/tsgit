import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import {
  invalidateIndexCache,
  readIndex,
} from '../../../../src/application/primitives/read-index.js';
import { parseResolveUndo } from '../../../../src/domain/git-index/resolve-undo.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';
import { indexExtensionsOf } from '../primitives/helpers/index-extensions.js';
import { seedIndex } from './add-index-fixtures.js';
import { seedRepo } from './fixtures.js';

const SHA1_DIGEST = 20;

type Ctx = ReturnType<typeof createMemoryContext>;

const TREE: Readonly<Record<string, string>> = {
  'a/b': 'b',
  'a/c': 'c',
  'a/x/y': 'y',
  'real/b': 'rb',
  top: 'top',
};

const trackedTree = async (): Promise<Ctx> => {
  const ctx = createMemoryContext();
  await seedRepo(ctx, { workingTree: TREE });
  await add(ctx, [], { all: true });
  return ctx;
};

const replaceDirectoryWithSymlink = async (ctx: Ctx, path: string): Promise<void> => {
  await ctx.fs.rmRecursive(`${ctx.layout.workDir}/${path}`);
  await ctx.fs.symlink('real', `${ctx.layout.workDir}/${path}`);
};

const replaceDirectoryWithFile = async (ctx: Ctx, path: string): Promise<void> => {
  await ctx.fs.rmRecursive(`${ctx.layout.workDir}/${path}`);
  await ctx.fs.write(`${ctx.layout.workDir}/${path}`, new TextEncoder().encode('now a file'));
};

const indexPaths = async (ctx: Ctx): Promise<string[]> => {
  invalidateIndexCache(ctx);
  const { entries } = await readIndex(ctx);
  return entries.map((entry) => `${entry.path}@${entry.flags.stage}:${entry.mode}`);
};

const unmergedBeneath = async (): Promise<Ctx> => {
  const ctx = await trackedTree();
  await seedIndex(ctx, [
    { path: 'a/b', text: 'base', stage: 1 },
    { path: 'a/b', text: 'ours', stage: 2 },
    { path: 'a/b', text: 'theirs', stage: 3 },
    { path: 'a/c', text: 'c' },
    { path: 'a/x/y', text: 'y' },
    { path: 'top', text: 'top' },
  ]);
  return ctx;
};

const recordedStages = async (
  ctx: Ctx,
): Promise<ReadonlyArray<readonly [string, ReadonlyArray<number>]>> => {
  const reuc = (await indexExtensionsOf(ctx)).get('REUC');
  if (reuc === undefined) return [];
  const records = parseResolveUndo(reuc, SHA1_DIGEST) ?? [];
  return records.map((record) => [record.path, record.stages.map(({ stage }) => stage)]);
};

describe('add — a tracked directory replaced by a non-directory', () => {
  describe('Given a tracked directory replaced by a symlink', () => {
    describe('When add names the symlink', () => {
      it('Then every entry beneath it is reported removed and dropped', async () => {
        // Arrange
        const ctx = await trackedTree();
        await replaceDirectoryWithSymlink(ctx, 'a');

        // Act
        const sut = await add(ctx, ['a']);

        // Assert
        expect(sut.removed).toEqual(['a/b', 'a/c', 'a/x/y']);
        expect(await indexPaths(ctx)).toEqual(['a@0:120000', 'real/b@0:100644', 'top@0:100644']);
      });
    });
  });

  describe('Given a tracked directory replaced by a regular file', () => {
    describe('When add names the file', () => {
      it('Then every entry beneath it is reported removed and dropped', async () => {
        // Arrange
        const ctx = await trackedTree();
        await replaceDirectoryWithFile(ctx, 'a');

        // Act
        const sut = await add(ctx, ['a']);

        // Assert
        expect(sut.removed).toEqual(['a/b', 'a/c', 'a/x/y']);
        expect(await indexPaths(ctx)).toEqual(['a@0:100644', 'real/b@0:100644', 'top@0:100644']);
      });
    });
  });

  describe('Given a tracked directory replaced by a symlink', () => {
    describe('When add names it as ./a', () => {
      it('Then the entries beneath it are reported removed', async () => {
        // Arrange
        const ctx = await trackedTree();
        await replaceDirectoryWithSymlink(ctx, 'a');

        // Act
        const sut = await add(ctx, ['./a']);

        // Assert
        expect(sut.removed).toEqual(['a/b', 'a/c', 'a/x/y']);
      });
    });

    describe('When add names it beside an unchanged tracked file', () => {
      it('Then the entries beneath it are reported removed and the file is untouched', async () => {
        // Arrange
        const ctx = await trackedTree();
        await replaceDirectoryWithSymlink(ctx, 'a');

        // Act
        const sut = await add(ctx, ['top', 'a']);

        // Assert
        expect(sut.removed).toEqual(['a/b', 'a/c', 'a/x/y']);
        expect(sut.modified).toEqual([]);
      });
    });
  });

  describe('Given a nested tracked directory replaced by a symlink', () => {
    describe('When add names the symlink', () => {
      it('Then only the entries beneath it are reported removed', async () => {
        // Arrange
        const ctx = await trackedTree();
        await replaceDirectoryWithSymlink(ctx, 'a/x');

        // Act
        const sut = await add(ctx, ['a/x']);

        // Assert
        expect(sut.removed).toEqual(['a/x/y']);
        expect(await indexPaths(ctx)).toEqual([
          'a/b@0:100644',
          'a/c@0:100644',
          'a/x@0:120000',
          'real/b@0:100644',
          'top@0:100644',
        ]);
      });
    });
  });

  describe('Given a symlink already staged at a, with entries beneath a still tracked', () => {
    describe('When add names a again', () => {
      it('Then the entries beneath it are kept: a stage-0 entry is replaced in place', async () => {
        // Arrange
        const ctx = await trackedTree();
        await seedIndex(ctx, [
          { path: 'a', text: 'real', mode: FILE_MODE.SYMLINK },
          { path: 'a/b', text: 'b' },
          { path: 'a/c', text: 'c' },
        ]);
        await replaceDirectoryWithSymlink(ctx, 'a');
        await ctx.fs.rm(`${ctx.layout.workDir}/a`);
        await ctx.fs.symlink('elsewhere', `${ctx.layout.workDir}/a`);

        // Act
        const sut = await add(ctx, ['a']);

        // Assert
        expect(sut.removed).toEqual([]);
        expect(sut.modified).toEqual(['a']);
        expect(await indexPaths(ctx)).toEqual(['a@0:120000', 'a/b@0:100644', 'a/c@0:100644']);
      });
    });
  });

  describe('Given a lossy path beneath a tracked directory replaced by a symlink', () => {
    describe('When add names the symlink', () => {
      it('Then the lossy entry is reported by its replacement-character view and dropped', async () => {
        // Arrange
        const ctx = await trackedTree();
        await seedIndex(ctx, [
          { path: new Uint8Array([0x61, 0x2f, 0xff]), text: 'lossy' },
          { path: 'top', text: 'top' },
        ]);
        await replaceDirectoryWithSymlink(ctx, 'a');

        // Act
        const sut = await add(ctx, ['a']);

        // Assert
        expect(sut.removed).toEqual(['a/\uFFFD']);
        expect(await indexPaths(ctx)).toEqual(['a@0:120000', 'top@0:100644']);
      });
    });
  });

  describe('Given an unchanged tracked file', () => {
    describe('When add names it', () => {
      it('Then the entries of the directories beside it are not touched', async () => {
        // Arrange
        const ctx = await trackedTree();

        // Act
        const sut = await add(ctx, ['top']);

        // Assert
        expect(sut.removed).toEqual([]);
        expect(await indexPaths(ctx)).toHaveLength(5);
      });
    });
  });

  describe('Given a tracked directory replaced by a symlink', () => {
    describe('When add excludes one of the entries beneath it', () => {
      it('Then that entry is dropped without being reported', async () => {
        // Arrange
        const ctx = await trackedTree();
        await replaceDirectoryWithFile(ctx, 'a');

        // Act
        const sut = await add(ctx, ['a', '!a/b']);

        // Assert
        expect(sut.removed).toEqual(['a/c', 'a/x/y']);
        expect(await indexPaths(ctx)).toEqual(['a@0:100644', 'real/b@0:100644', 'top@0:100644']);
      });
    });
  });

  describe('Given an entry beneath a replaced directory marked skip-worktree', () => {
    describe('When add names the symlink', () => {
      it('Then that entry is dropped without being reported', async () => {
        // Arrange
        const ctx = await trackedTree();
        await seedIndex(ctx, [
          { path: 'a/b', text: 'b', skipWorktree: true },
          { path: 'a/c', text: 'c' },
          { path: 'a/x/y', text: 'y' },
          { path: 'top', text: 'top' },
        ]);
        await replaceDirectoryWithSymlink(ctx, 'a');

        // Act
        const sut = await add(ctx, ['a']);

        // Assert
        expect(sut.removed).toEqual(['a/c', 'a/x/y']);
        expect(await indexPaths(ctx)).toEqual(['a@0:120000', 'top@0:100644']);
      });
    });
  });

  describe('Given an entry beneath a replaced directory unmerged at stages 1, 2 and 3', () => {
    describe.each([
      ['add names the symlink', ['a']],
      ['add excludes that entry by name', ['a', '!a/b']],
    ])('When %s', (_title, paths) => {
      it('Then every stage of it is dropped, reported once and recorded in resolve-undo', async () => {
        // Arrange
        const ctx = await unmergedBeneath();
        await replaceDirectoryWithFile(ctx, 'a');

        // Act
        const sut = await add(ctx, paths);

        // Assert
        expect(sut.removed).toEqual(['a/b', 'a/c', 'a/x/y']);
        expect(await indexPaths(ctx)).toEqual(['a@0:100644', 'top@0:100644']);
        expect(await recordedStages(ctx)).toEqual([['a/b', [1, 2, 3]]]);
      });
    });
  });

  describe('Given an entry beneath a replaced directory unmerged at stages 1, 2 and 3', () => {
    describe('When add excludes it with a glob', () => {
      it('Then every stage of it is kept and nothing is recorded in resolve-undo', async () => {
        // Arrange
        const ctx = await unmergedBeneath();
        await replaceDirectoryWithFile(ctx, 'a');

        // Act
        const sut = await add(ctx, ['a', '!a/b*']);

        // Assert
        expect(sut.removed).toEqual(['a/c', 'a/x/y']);
        expect(await indexPaths(ctx)).toEqual([
          'a@0:100644',
          'a/b@1:100644',
          'a/b@2:100644',
          'a/b@3:100644',
          'top@0:100644',
        ]);
        expect(await recordedStages(ctx)).toEqual([]);
      });
    });
  });

  describe('Given a path unmerged at stages 1, 2 and 3 with stage-0 entries beneath it', () => {
    describe.each([
      ['a file', replaceDirectoryWithFile],
      ['a symlink', replaceDirectoryWithSymlink],
    ])('When it is now %s and add names it', (_title, replace) => {
      it.each([
        ['alone', ['a']],
        ['beside another path', ['a', 'top']],
      ])('Then the entries beneath it are dropped silently (%s)', async (_how, paths) => {
        // Arrange
        const ctx = await trackedTree();
        await seedIndex(ctx, [
          { path: 'a', text: 'base', stage: 1 },
          { path: 'a', text: 'ours', stage: 2 },
          { path: 'a', text: 'theirs', stage: 3 },
          { path: 'a/b', text: 'b' },
          { path: 'a/c', text: 'c' },
          { path: 'real/b', text: 'rb' },
          { path: 'top', text: 'top' },
        ]);
        await replace(ctx, 'a');

        // Act
        const sut = await add(ctx, paths);

        // Assert
        expect(sut.removed).toEqual([]);
        expect(sut.modified).toEqual(['a']);
        expect((await indexPaths(ctx)).map((line) => line.split(':')[0])).toEqual([
          'a@0',
          'real/b@0',
          'top@0',
        ]);
        expect(await recordedStages(ctx)).toEqual([['a', [1, 2, 3]]]);
      });
    });
  });

  describe('Given a tracked directory replaced by a file and an excluded entry beneath it', () => {
    describe('When add walks the whole tree excluding that entry', () => {
      it('Then the excluded entry is dropped silently beside the reported ones', async () => {
        // Arrange
        const ctx = await trackedTree();
        await replaceDirectoryWithFile(ctx, 'a');

        // Act
        const sut = await add(ctx, ['.', '!a/b']);

        // Assert
        expect(sut.removed).toEqual(['a/c', 'a/x/y']);
        expect(await indexPaths(ctx)).toEqual(['a@0:100644', 'real/b@0:100644', 'top@0:100644']);
      });
    });
  });

  describe('Given a tracked directory replaced by a symlink with a skip-worktree entry beneath it', () => {
    describe('When add stages everything', () => {
      it('Then the skip-worktree entry is dropped silently beside the reported ones', async () => {
        // Arrange
        const ctx = await trackedTree();
        await seedIndex(ctx, [
          { path: 'a/b', text: 'b', skipWorktree: true },
          { path: 'a/c', text: 'c' },
          { path: 'a/x/y', text: 'y' },
          { path: 'real/b', text: 'rb' },
          { path: 'top', text: 'top' },
        ]);
        await replaceDirectoryWithSymlink(ctx, 'a');

        // Act
        const sut = await add(ctx, [], { all: true });

        // Assert
        expect(sut.removed).toEqual(['a/c', 'a/x/y']);
        expect(await indexPaths(ctx)).toEqual(['a@0:120000', 'real/b@0:100644', 'top@0:100644']);
      });
    });
  });

  describe.each([
    ['the whole tree', ['.']],
    ['the whole tree excluding it', ['.', '!a/b']],
  ])('Given an unmerged entry beneath a replaced directory', (_title, paths) => {
    describe(`When add names ${_title}`, () => {
      it('Then it is reported once, leaves no stage and is recorded in resolve-undo', async () => {
        // Arrange
        const ctx = await unmergedBeneath();
        await replaceDirectoryWithFile(ctx, 'a');

        // Act
        const sut = await add(ctx, paths);

        // Assert
        expect(sut.removed).toEqual(['a/b', 'a/c', 'a/x/y']);
        expect(await indexPaths(ctx)).toEqual(['a@0:100644', 'real/b@0:100644', 'top@0:100644']);
        expect(await recordedStages(ctx)).toEqual([['a/b', [1, 2, 3]]]);
      });
    });
  });

  describe('Given an unmerged entry beneath a replaced directory', () => {
    describe('When add stages everything', () => {
      it('Then it is reported once and recorded in resolve-undo', async () => {
        // Arrange
        const ctx = await unmergedBeneath();
        await replaceDirectoryWithFile(ctx, 'a');

        // Act
        const sut = await add(ctx, [], { all: true });

        // Assert
        expect(sut.removed).toEqual(['a/b', 'a/c', 'a/x/y']);
        expect(await recordedStages(ctx)).toEqual([['a/b', [1, 2, 3]]]);
      });
    });

    describe('When add excludes it with a glob over the whole tree', () => {
      it('Then every stage of it is kept', async () => {
        // Arrange
        const ctx = await unmergedBeneath();
        await replaceDirectoryWithFile(ctx, 'a');

        // Act
        const sut = await add(ctx, ['.', '!a/b*']);

        // Assert
        expect(sut.removed).toEqual(['a/c', 'a/x/y']);
        expect((await indexPaths(ctx)).filter((line) => line.startsWith('a/b'))).toEqual([
          'a/b@1:100644',
          'a/b@2:100644',
          'a/b@3:100644',
        ]);
      });
    });
  });

  describe('Given a path unmerged with stage-0 entries beneath it', () => {
    describe.each([
      ['a file', replaceDirectoryWithFile],
      ['a symlink', replaceDirectoryWithSymlink],
    ])('When it is now %s and add names it beside a directory', (_title, replace) => {
      it('Then the entries beneath it are dropped silently', async () => {
        // Arrange
        const ctx = await trackedTree();
        await seedIndex(ctx, [
          { path: 'a', text: 'base', stage: 1 },
          { path: 'a', text: 'ours', stage: 2 },
          { path: 'a', text: 'theirs', stage: 3 },
          { path: 'a/b', text: 'b' },
          { path: 'a/c', text: 'c' },
          { path: 'd/e', text: 'e' },
          { path: 'real/b', text: 'rb' },
          { path: 'top', text: 'top' },
        ]);
        await ctx.fs.write(`${ctx.layout.workDir}/d/e`, new TextEncoder().encode('changed'));
        await replace(ctx, 'a');

        // Act
        const sut = await add(ctx, ['a', 'd']);

        // Assert
        expect(sut.removed).toEqual([]);
        expect(sut.modified).toEqual(['a', 'd/e']);
        expect((await indexPaths(ctx)).map((line) => line.split(':')[0])).toEqual([
          'a@0',
          'd/e@0',
          'real/b@0',
          'top@0',
        ]);
        expect(await recordedStages(ctx)).toEqual([['a', [1, 2, 3]]]);
      });
    });

    describe('When it is now a file and add walks the whole tree', () => {
      it('Then the entries beneath it are reported', async () => {
        // Arrange
        const ctx = await trackedTree();
        await seedIndex(ctx, [
          { path: 'a', text: 'base', stage: 1 },
          { path: 'a', text: 'ours', stage: 2 },
          { path: 'a/b', text: 'b' },
          { path: 'top', text: 'top' },
        ]);
        await replaceDirectoryWithFile(ctx, 'a');

        // Act
        const sut = await add(ctx, ['.']);

        // Assert
        expect(sut.removed).toEqual(['a/b']);
      });
    });
  });

  describe('Given a tracked directory replaced by a file', () => {
    describe('When add names a path under another directory', () => {
      it('Then the replaced directory is left alone', async () => {
        // Arrange
        const ctx = await trackedTree();
        await replaceDirectoryWithFile(ctx, 'a');

        // Act
        const sut = await add(ctx, ['real']);

        // Assert
        expect(sut.removed).toEqual([]);
        expect((await indexPaths(ctx)).length).toBe(5);
      });
    });
  });
});
