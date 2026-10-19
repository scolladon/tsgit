import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import {
  invalidateIndexCache,
  readIndex,
} from '../../../../src/application/primitives/read-index.js';
import { parseResolveUndo } from '../../../../src/domain/git-index/resolve-undo.js';
import { TsgitError } from '../../../../src/domain/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';
import { FilePath } from '../../../../src/domain/objects/object-id.js';
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

const MIRROR_TREE: Readonly<Record<string, string>> = { a: 'a', 'real/b': 'rb', top: 'top' };

const replaceWithDirectory = async (ctx: Ctx): Promise<void> => {
  await ctx.fs.rm(`${ctx.layout.workDir}/a`);
  await ctx.fs.write(`${ctx.layout.workDir}/a/b`, new TextEncoder().encode('b'));
};

const trackedFile = async (): Promise<Ctx> => {
  const ctx = createMemoryContext();
  await seedRepo(ctx, { workingTree: MIRROR_TREE });
  await add(ctx, [], { all: true });
  return ctx;
};

const trackedSymlink = async (): Promise<Ctx> => {
  const ctx = createMemoryContext();
  await seedRepo(ctx, { workingTree: { 'real/b': 'rb', top: 'top' } });
  await ctx.fs.symlink('real', `${ctx.layout.workDir}/a`);
  await add(ctx, [], { all: true });
  return ctx;
};

const unmergedFile = async (): Promise<Ctx> => {
  const ctx = await trackedFile();
  await seedIndex(ctx, [
    { path: 'a', text: 'base', stage: 1 },
    { path: 'a', text: 'ours', stage: 2 },
    { path: 'a', text: 'theirs', stage: 3 },
    { path: 'real/b', text: 'rb' },
    { path: 'top', text: 'top' },
  ]);
  return ctx;
};

const skipWorktreeFile = async (): Promise<Ctx> => {
  const ctx = await trackedFile();
  await seedIndex(ctx, [
    { path: 'a', text: 'a', skipWorktree: true },
    { path: 'real/b', text: 'rb' },
    { path: 'top', text: 'top' },
  ]);
  return ctx;
};

describe('add — a tracked directory replaced by a non-directory', () => {
  describe('Given a tracked directory replaced by a symlink', () => {
    describe('When add names the symlink', () => {
      it('Then every entry beneath it is reported removed and dropped', async () => {
        // Arrange
        const ctx = await trackedTree();
        await replaceDirectoryWithSymlink(ctx, 'a');

        const sut = add;

        // Act
        const result = await sut(ctx, ['a']);

        // Assert
        expect(result.removed).toEqual(['a/b', 'a/c', 'a/x/y']);
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

        const sut = add;

        // Act
        const result = await sut(ctx, ['a']);

        // Assert
        expect(result.removed).toEqual(['a/b', 'a/c', 'a/x/y']);
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

        const sut = add;

        // Act
        const result = await sut(ctx, ['./a']);

        // Assert
        expect(result.removed).toEqual(['a/b', 'a/c', 'a/x/y']);
      });
    });

    describe('When add names it beside an unchanged tracked file', () => {
      it('Then the entries beneath it are reported removed and the file is untouched', async () => {
        // Arrange
        const ctx = await trackedTree();
        await replaceDirectoryWithSymlink(ctx, 'a');

        const sut = add;

        // Act
        const result = await sut(ctx, ['top', 'a']);

        // Assert
        expect(result.removed).toEqual(['a/b', 'a/c', 'a/x/y']);
        expect(result.modified).toEqual([]);
      });
    });
  });

  describe('Given a nested tracked directory replaced by a symlink', () => {
    describe('When add names the symlink', () => {
      it('Then only the entries beneath it are reported removed', async () => {
        // Arrange
        const ctx = await trackedTree();
        await replaceDirectoryWithSymlink(ctx, 'a/x');

        const sut = add;

        // Act
        const result = await sut(ctx, ['a/x']);

        // Assert
        expect(result.removed).toEqual(['a/x/y']);
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

  describe('Given a file staged at a, with entries beneath a still tracked', () => {
    describe('When add walks the whole tree excluding one of them', () => {
      it('Then the excluded entry is kept: a stage-0 entry is replaced in place', async () => {
        // Arrange
        const ctx = await trackedTree();
        await seedIndex(ctx, [
          { path: 'a', text: 'was' },
          { path: 'a/b', text: 'b' },
          { path: 'a/c', text: 'c' },
        ]);
        await replaceDirectoryWithFile(ctx, 'a');

        const sut = add;

        // Act
        const result = await sut(ctx, ['.', '!a/b']);

        // Assert
        expect(result.removed).toEqual(['a/c']);
        expect(result.modified).toEqual(['a']);
        expect(await indexPaths(ctx)).toEqual([
          'a@0:100644',
          'a/b@0:100644',
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

        const sut = add;

        // Act
        const result = await sut(ctx, ['a']);

        // Assert
        expect(result.removed).toEqual([]);
        expect(result.modified).toEqual(['a']);
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

        const sut = add;

        // Act
        const result = await sut(ctx, ['a']);

        // Assert
        expect(result.removed).toEqual(['a/\uFFFD']);
        expect(await indexPaths(ctx)).toEqual(['a@0:120000', 'top@0:100644']);
      });
    });
  });

  describe('Given an unchanged tracked file', () => {
    describe('When add names it', () => {
      it('Then the entries of the directories beside it are not touched', async () => {
        // Arrange
        const ctx = await trackedTree();

        const sut = add;

        // Act
        const result = await sut(ctx, ['top']);

        // Assert
        expect(result.removed).toEqual([]);
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

        const sut = add;

        // Act
        const result = await sut(ctx, ['a', '!a/b']);

        // Assert
        expect(result.removed).toEqual(['a/c', 'a/x/y']);
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

        const sut = add;

        // Act
        const result = await sut(ctx, ['a']);

        // Assert
        expect(result.removed).toEqual(['a/c', 'a/x/y']);
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

        const sut = add;

        // Act
        const result = await sut(ctx, paths);

        // Assert
        expect(result.removed).toEqual(['a/b', 'a/c', 'a/x/y']);
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

        const sut = add;

        // Act
        const result = await sut(ctx, ['a', '!a/b*']);

        // Assert
        expect(result.removed).toEqual(['a/c', 'a/x/y']);
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

        const sut = add;

        // Act
        const result = await sut(ctx, paths);

        // Assert
        expect(result.removed).toEqual([]);
        expect(result.modified).toEqual(['a']);
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

        const sut = add;

        // Act
        const result = await sut(ctx, ['.', '!a/b']);

        // Assert
        expect(result.removed).toEqual(['a/c', 'a/x/y']);
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

        const sut = add;

        // Act
        const result = await sut(ctx, [], { all: true });

        // Assert
        expect(result.removed).toEqual(['a/c', 'a/x/y']);
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

        const sut = add;

        // Act
        const result = await sut(ctx, paths);

        // Assert
        expect(result.removed).toEqual(['a/b', 'a/c', 'a/x/y']);
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

        const sut = add;

        // Act
        const result = await sut(ctx, [], { all: true });

        // Assert
        expect(result.removed).toEqual(['a/b', 'a/c', 'a/x/y']);
        expect(await recordedStages(ctx)).toEqual([['a/b', [1, 2, 3]]]);
      });
    });

    describe('When add excludes it with a glob over the whole tree', () => {
      it('Then every stage of it is kept', async () => {
        // Arrange
        const ctx = await unmergedBeneath();
        await replaceDirectoryWithFile(ctx, 'a');

        const sut = add;

        // Act
        const result = await sut(ctx, ['.', '!a/b*']);

        // Assert
        expect(result.removed).toEqual(['a/c', 'a/x/y']);
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

        const sut = add;

        // Act
        const result = await sut(ctx, ['a', 'd']);

        // Assert
        expect(result.removed).toEqual([]);
        expect(result.modified).toEqual(['a', 'd/e']);
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

        const sut = add;

        // Act
        const result = await sut(ctx, ['.']);

        // Assert
        expect(result.removed).toEqual(['a/b']);
        expect(result.modified).toEqual(['a']);
        expect((await indexPaths(ctx)).map((line) => line.split(':')[0])).toEqual([
          'a@0',
          'real/b@0',
          'top@0',
        ]);
        expect(await recordedStages(ctx)).toEqual([['a', [1, 2]]]);
      });
    });
  });

  describe.each([
    { label: 'stage 2 only', stages: [2] as const },
    { label: 'stage 3 only', stages: [3] as const },
    { label: 'stages 1 and 2', stages: [1, 2] as const },
  ])('Given a path unmerged at $label with stage-0 entries beneath it', ({ stages }) => {
    const seedPartial = async (): Promise<Ctx> => {
      const ctx = await trackedTree();
      await seedIndex(ctx, [
        ...stages.map((stage) => ({ path: 'a', text: `a-${stage}`, stage })),
        { path: 'a/b', text: 'b' },
        { path: 'a/c', text: 'c' },
        { path: 'a/x/y', text: 'y' },
        { path: 'd/e', text: 'e' },
        { path: 'real/b', text: 'rb' },
        { path: 'top', text: 'top' },
      ]);
      await ctx.fs.write(`${ctx.layout.workDir}/d/e`, new TextEncoder().encode('changed'));
      await replaceDirectoryWithFile(ctx, 'a');
      return ctx;
    };

    describe.each([
      { how: 'add a', paths: ['a'], options: undefined, removed: [], modified: ['a'] },
      {
        how: 'add a d',
        paths: ['a', 'd'],
        options: undefined,
        removed: [],
        modified: ['a', 'd/e'],
      },
      {
        how: 'add a .',
        paths: ['a', '.'],
        options: undefined,
        removed: ['a/b', 'a/c', 'a/x/y'],
        modified: ['a', 'd/e'],
      },
      {
        how: 'add -A',
        paths: [] as string[],
        options: { all: true },
        removed: ['a/b', 'a/c', 'a/x/y'],
        modified: ['a', 'd/e'],
      },
    ])('When $how', ({ paths, options, removed, modified }) => {
      it('Then the file is stage 0, the stages are recorded and only the reported entries beneath go', async () => {
        // Arrange
        const ctx = await seedPartial();

        const sut = add;

        // Act
        const result = await sut(ctx, paths, options);

        // Assert
        expect(result.removed).toEqual(removed);
        expect(result.modified).toEqual(modified);
        expect((await indexPaths(ctx)).map((line) => line.split(':')[0])).toEqual([
          'a@0',
          'd/e@0',
          'real/b@0',
          'top@0',
        ]);
        expect(await recordedStages(ctx)).toEqual([['a', stages]]);
      });
    });
  });

  describe('Given a nested path unmerged at stages 1, 2 and 3 with a stage-0 entry beneath it', () => {
    const seedNested = async (): Promise<Ctx> => {
      const ctx = createMemoryContext();
      await seedRepo(ctx, { workingTree: { 'x/a/b': 'b', 'real/b': 'rb', top: 'top' } });
      await seedIndex(ctx, [
        { path: 'x/a', text: 'base', stage: 1 },
        { path: 'x/a', text: 'ours', stage: 2 },
        { path: 'x/a', text: 'theirs', stage: 3 },
        { path: 'x/a/b', text: 'b' },
        { path: 'real/b', text: 'rb' },
        { path: 'top', text: 'top' },
      ]);
      await replaceDirectoryWithFile(ctx, 'x/a');
      return ctx;
    };

    describe.each([
      { how: 'x', paths: ['x'], removed: ['x/a/b'] },
      { how: 'x/a', paths: ['x/a'], removed: [] },
    ])('When add names $how', ({ paths, removed }) => {
      it('Then x/a is stage 0 and only the reported entry beneath it goes', async () => {
        // Arrange
        const ctx = await seedNested();

        const sut = add;

        // Act
        const result = await sut(ctx, paths);

        // Assert
        expect(result.removed).toEqual(removed);
        expect(result.modified).toEqual(['x/a']);
        expect((await indexPaths(ctx)).map((line) => line.split(':')[0])).toEqual([
          'real/b@0',
          'top@0',
          'x/a@0',
        ]);
        expect(await recordedStages(ctx)).toEqual([['x/a', [1, 2, 3]]]);
      });
    });
  });

  describe('Given a tracked directory replaced by a file', () => {
    describe('When add names a path under another directory', () => {
      it('Then the replaced directory is left alone', async () => {
        // Arrange
        const ctx = await trackedTree();
        await replaceDirectoryWithFile(ctx, 'a');

        const sut = add;

        // Act
        const result = await sut(ctx, ['real']);

        // Assert
        expect(result.removed).toEqual([]);
        expect((await indexPaths(ctx)).length).toBe(5);
      });
    });
  });
});

describe('add — a path beneath a regular file that replaced a tracked directory', () => {
  describe('Given a tracked directory replaced by a regular file', () => {
    describe('When add names a path beneath the file', () => {
      it('Then the removal of that path is staged', async () => {
        // Arrange
        const ctx = await trackedTree();
        await replaceDirectoryWithFile(ctx, 'a');

        const sut = add;

        // Act
        const result = await sut(ctx, ['a/b']);

        // Assert
        expect(result.removed).toEqual(['a/b']);
        expect(await indexPaths(ctx)).toEqual([
          'a/c@0:100644',
          'a/x/y@0:100644',
          'real/b@0:100644',
          'top@0:100644',
        ]);
      });
    });

    describe('When add names the file and a path beneath it', () => {
      it('Then the file is added and every entry beneath it is removed', async () => {
        // Arrange
        const ctx = await trackedTree();
        await replaceDirectoryWithFile(ctx, 'a');

        const sut = add;

        // Act
        const result = await sut(ctx, ['a', 'a/b']);

        // Assert
        expect(result.added).toEqual(['a']);
        expect(result.removed).toEqual(['a/b', 'a/c', 'a/x/y']);
      });
    });
  });

  describe('Given a file unmerged at stages 1, 2 and 3 over stage-0 entries a/b and a/c', () => {
    describe('When add names a/b then the file', () => {
      it('Then only a/b is reported removed and the stages are recorded', async () => {
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
        await replaceDirectoryWithFile(ctx, 'a');

        const sut = add;

        // Act
        const result = await sut(ctx, ['a/b', 'a']);

        // Assert
        expect(result.removed).toEqual(['a/b']);
        expect((await indexPaths(ctx)).map((line) => line.split(':')[0])).toEqual([
          'a@0',
          'real/b@0',
          'top@0',
        ]);
        expect(await recordedStages(ctx)).toEqual([['a', [1, 2, 3]]]);
      });
    });
  });

  describe('Given a tracked directory replaced by a file and a first probe of a path beneath it that fails', () => {
    const failingFirstProbe = async (failure: Error): Promise<Ctx> => {
      const ctx = await trackedTree();
      await replaceDirectoryWithFile(ctx, 'a');
      const beneath = `${ctx.layout.workDir}/a/b`;
      const baseLstat = ctx.fs.lstat;
      let probed = false;
      const fs = new Proxy(ctx.fs, {
        get(target, prop, receiver) {
          if (prop !== 'lstat') return Reflect.get(target, prop, receiver);
          return async (path: string) => {
            if (path === beneath && !probed) {
              probed = true;
              throw failure;
            }
            return baseLstat(path);
          };
        },
      });
      return { ...ctx, fs };
    };

    describe('When the failure is a TsgitError other than NOT_A_DIRECTORY', () => {
      it('Then add rethrows it', async () => {
        // Arrange
        const ctx = await failingFirstProbe(
          new TsgitError({ code: 'PERMISSION_DENIED', path: FilePath.from('a/b') }),
        );
        const sut = add;

        // Act
        const code = await sut(ctx, ['a/b']).then(
          () => undefined,
          (err: { data: { code: string } }) => err.data.code,
        );

        // Assert
        expect(code).toBe('PERMISSION_DENIED');
      });
    });

    describe('When the failure is not a TsgitError', () => {
      it('Then add rethrows it', async () => {
        // Arrange
        const ctx = await failingFirstProbe(new Error('disk on fire'));
        const sut = add;

        // Act
        const message = await sut(ctx, ['a/b']).then(
          () => undefined,
          (err: Error) => err.message,
        );

        // Assert
        expect(message).toBe('disk on fire');
      });
    });
  });

  describe('Given a renormalize add of a path beneath a regular file', () => {
    describe.each([['a/b'], ['a']])('When it names %s', (literal) => {
      it('Then it is refused as not a directory', async () => {
        // Arrange
        const ctx = await trackedTree();
        await replaceDirectoryWithFile(ctx, 'a');
        const code = await add(ctx, [literal], { renormalize: true }).then(
          () => undefined,
          (err: { data: { code: string } }) => err.data.code,
        );

        // Assert
        expect(code).toBe('NOT_A_DIRECTORY');
      });
    });
  });
});

describe('add — a directory replaced a tracked file or symlink', () => {
  describe.each([
    ['a tracked file', trackedFile],
    ['a tracked symlink', trackedSymlink],
  ])('Given a directory that replaced %s', (_title, track) => {
    describe.each([
      { how: 'add a/b', paths: ['a/b'], options: undefined, removed: [] },
      { how: 'add a/', paths: ['a/'], options: undefined, removed: [] },
      { how: 'add a/*', paths: ['a/*'], options: undefined, removed: [] },
      { how: 'add a', paths: ['a'], options: undefined, removed: ['a'] },
      { how: 'add .', paths: ['.'], options: undefined, removed: ['a'] },
      { how: 'add -A', paths: [] as string[], options: { all: true }, removed: ['a'] },
    ])('When $how', ({ paths, options, removed }) => {
      it('Then the replaced entry is gone and a/b is staged', async () => {
        // Arrange
        const ctx = await track();
        await ctx.fs.rm(`${ctx.layout.workDir}/a`);
        await ctx.fs.write(`${ctx.layout.workDir}/a/b`, new TextEncoder().encode('b'));

        const sut = add;

        // Act
        const result = await sut(ctx, paths, options);

        // Assert
        expect(result.removed).toEqual(removed);
        expect(await indexPaths(ctx)).toEqual(['a/b@0:100644', 'real/b@0:100644', 'top@0:100644']);
      });
    });
  });

  describe('Given a skip-worktree file that a directory replaced', () => {
    describe.each([
      { how: 'add -A', paths: [] as string[], options: { all: true } },
      { how: 'add .', paths: ['.'], options: undefined },
    ])('When $how', ({ paths, options }) => {
      it('Then the entry is dropped without being reported', async () => {
        // Arrange
        const ctx = await skipWorktreeFile();
        await replaceWithDirectory(ctx);

        const sut = add;

        // Act
        const result = await sut(ctx, paths, options);

        // Assert
        expect(result.removed).toEqual([]);
        expect(await indexPaths(ctx)).toEqual(['a/b@0:100644', 'real/b@0:100644', 'top@0:100644']);
      });
    });
  });

  describe('Given a file unmerged at stages 1, 2 and 3 that a directory replaced', () => {
    describe('When add names a/b', () => {
      it('Then every stage is kept beside a/b and nothing is recorded', async () => {
        // Arrange
        const ctx = await unmergedFile();
        await replaceWithDirectory(ctx);

        const sut = add;

        // Act
        const result = await sut(ctx, ['a/b']);

        // Assert
        expect(result.removed).toEqual([]);
        expect(await indexPaths(ctx)).toEqual([
          'a@1:100644',
          'a@2:100644',
          'a@3:100644',
          'a/b@0:100644',
          'real/b@0:100644',
          'top@0:100644',
        ]);
        expect(await recordedStages(ctx)).toEqual([]);
      });
    });

    describe('When add -A', () => {
      it('Then every stage is removed and recorded', async () => {
        // Arrange
        const ctx = await unmergedFile();
        await replaceWithDirectory(ctx);

        const sut = add;

        // Act
        const result = await sut(ctx, [], { all: true });

        // Assert
        expect(result.removed).toEqual(['a']);
        expect(await indexPaths(ctx)).toEqual(['a/b@0:100644', 'real/b@0:100644', 'top@0:100644']);
        expect(await recordedStages(ctx)).toEqual([['a', [1, 2, 3]]]);
      });
    });
  });

  describe('Given a tracked gitlink whose directory exists', () => {
    describe('When add -A', () => {
      it('Then the gitlink is kept', async () => {
        // Arrange
        const ctx = await trackedFile();
        await seedIndex(ctx, [
          { path: 'a', text: 'a', mode: FILE_MODE.GITLINK },
          { path: 'real/b', text: 'rb' },
          { path: 'top', text: 'top' },
        ]);
        await replaceWithDirectory(ctx);
        await ctx.fs.rm(`${ctx.layout.workDir}/a/b`);

        const sut = add;

        // Act
        const result = await sut(ctx, [], { all: true });

        // Assert
        expect(result.removed).toEqual([]);
        expect(await indexPaths(ctx)).toContain('a@0:160000');
      });
    });
  });

  describe('Given a directory replaced by a file and an unrelated tracked file deleted', () => {
    describe('When add -A runs', () => {
      it('Then the removals are reported in path order', async () => {
        // Arrange
        const ctx = await trackedTree();
        await replaceDirectoryWithFile(ctx, 'a');
        await ctx.fs.rm(`${ctx.layout.workDir}/real/b`);

        const sut = add;

        // Act
        const result = await sut(ctx, [], { all: true });

        // Assert
        expect(result.removed).toEqual(['a/b', 'a/c', 'a/x/y', 'real/b']);
      });
    });
  });
});

describe('Given an existing file and a regular file named with a trailing slash', () => {
  describe('When add names both', () => {
    it('Then it refuses the trailing-slash pathspec and stages neither', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedRepo(ctx, { workingTree: { f: 'f', g: 'g' } });
      const sut = add;

      // Act
      const outcome = await sut(ctx, ['g', 'f/']).then(
        () => undefined,
        (err: TsgitError) => err.data,
      );

      // Assert
      expect(outcome).toEqual({ code: 'PATHSPEC_NO_MATCH', pattern: 'f/' });
      expect(await indexPaths(ctx)).toEqual([]);
    });
  });
});
