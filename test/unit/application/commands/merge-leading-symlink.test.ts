import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
import { stashApply, stashPush } from '../../../../src/application/commands/stash.js';
import { applyMergeToWorktree } from '../../../../src/application/primitives/apply-merge-to-worktree.js';
import * as scannerMod from '../../../../src/application/primitives/internal/symlinked-leading-path.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { createInterleavingFs } from '../primitives/support/interleaving-fs.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const WORKDIR = '/repo';
const OUTSIDE = '/repo/.git/outside';

interface Placement {
  readonly link: string;
  readonly file: string;
}

const DEFAULT_PLACEMENT: Placement = { link: 'A', file: 'a/f' };

const seedConflictedMerge = async (
  withSymlink: boolean,
  placement: Placement = DEFAULT_PLACEMENT,
): Promise<Context> => {
  const ctx = createMemoryContext();
  const root = ctx.layout.workDir;
  await init(ctx);
  await ctx.fs.writeUtf8(`${root}/file.txt`, 'a\nb\nc\n');
  await add(ctx, ['file.txt']);
  await commit(ctx, { message: 'base', author });
  await branchCreate(ctx, { name: 'theirs' });
  await checkout(ctx, { rev: 'theirs' });
  await ctx.fs.writeUtf8(`${root}/file.txt`, 'a\nY\nc\n');
  await ctx.fs.mkdir(`${root}/${placement.file.split('/')[0]}`);
  await ctx.fs.writeUtf8(`${root}/${placement.file}`, 'payload');
  const staged = ['file.txt', placement.file];
  if (withSymlink) {
    await ctx.fs.symlink(OUTSIDE, `${root}/${placement.link}`);
    staged.push(placement.link);
  }
  await add(ctx, staged);
  await commit(ctx, { message: 'theirs', author });
  await checkout(ctx, { rev: 'main' });
  await ctx.fs.writeUtf8(`${root}/file.txt`, 'a\nX\nc\n');
  await add(ctx, ['file.txt']);
  await commit(ctx, { message: 'ours', author });
  return ctx;
};

const seedSymlinkAddAddConflict = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  const root = ctx.layout.workDir;
  await init(ctx);
  await ctx.fs.writeUtf8(`${root}/base.txt`, 'base');
  await add(ctx, ['base.txt']);
  await commit(ctx, { message: 'base', author });
  await branchCreate(ctx, { name: 'theirs' });
  await checkout(ctx, { rev: 'theirs' });
  await ctx.fs.symlink('theirs-target', `${root}/L`);
  await add(ctx, ['L']);
  await commit(ctx, { message: 'theirs', author });
  await checkout(ctx, { rev: 'main' });
  await ctx.fs.symlink('ours-target', `${root}/L`);
  await add(ctx, ['L']);
  await commit(ctx, { message: 'ours', author });
  return ctx;
};

const seedDistinctTypesConflict = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  const root = ctx.layout.workDir;
  await init(ctx);
  await ctx.fs.writeUtf8(`${root}/base.txt`, 'base');
  await add(ctx, ['base.txt']);
  await commit(ctx, { message: 'base', author });
  await branchCreate(ctx, { name: 'theirs' });
  await checkout(ctx, { rev: 'theirs' });
  await ctx.fs.writeUtf8(`${root}/A`, 'regular');
  await ctx.fs.mkdir(`${root}/a`);
  await ctx.fs.writeUtf8(`${root}/a/f`, 'payload');
  await add(ctx, ['A', 'a/f']);
  await commit(ctx, { message: 'theirs', author });
  await checkout(ctx, { rev: 'main' });
  await ctx.fs.symlink(OUTSIDE, `${root}/A`);
  await add(ctx, ['A']);
  await commit(ctx, { message: 'ours', author });
  return ctx;
};

describe('conflicted merge leading-symlink safety', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Given theirs adds symlink A and file a/f that one case-insensitive disk folds together', () => {
    describe('When the conflicted merge writes them', () => {
      it('Then a/f never lands through the link', async () => {
        // Arrange
        const inner = await seedConflictedMerge(true);
        await inner.fs.mkdir(OUTSIDE);
        const { fs, recorded } = createInterleavingFs(inner.fs, {
          foldUnder: WORKDIR,
        });
        const sut = mergeRun;

        // Act
        const result = await sut({ ...inner, fs }, { rev: 'theirs', author });

        // Assert
        expect(result.kind).toBe('conflict');
        expect(recorded).toEqual([]);
        expect(await inner.fs.readdir(OUTSIDE)).toEqual([]);
      });
    });
  });

  describe('Given theirs adds symlink b and file B/x that one case-insensitive disk folds together', () => {
    describe('When the conflicted merge writes them', () => {
      it('Then B/x never lands through the link', async () => {
        // Arrange
        const inner = await seedConflictedMerge(true, { link: 'b', file: 'B/x' });
        await inner.fs.mkdir(OUTSIDE);
        const { fs, recorded } = createInterleavingFs(inner.fs, {
          foldUnder: WORKDIR,
        });
        const sut = mergeRun;

        // Act
        const result = await sut({ ...inner, fs }, { rev: 'theirs', author });

        // Assert
        expect(result.kind).toBe('conflict');
        expect(recorded).toEqual([]);
        expect(await inner.fs.readdir(OUTSIDE)).toEqual([]);
      });
    });
  });

  describe('Given ours holds symlink A where theirs holds a file, and theirs adds a/f', () => {
    describe('When the distinct-types conflict is written on a case-insensitive disk', () => {
      it('Then a/f never lands through the link', async () => {
        // Arrange
        const inner = await seedDistinctTypesConflict();
        await inner.fs.mkdir(OUTSIDE);
        const { fs, recorded } = createInterleavingFs(inner.fs, {
          foldUnder: WORKDIR,
        });
        const sut = mergeRun;

        // Act
        const result = await sut({ ...inner, fs }, { rev: 'theirs', author });

        // Assert
        expect(result.kind).toBe('conflict');
        expect(recorded).toEqual([]);
        expect(await inner.fs.readdir(OUTSIDE)).toEqual([]);
      });
    });
  });

  describe('Given a conflicted merge whose theirs adds a symlink and a file', () => {
    describe('When it writes the working tree', () => {
      it('Then the conflict markers, the file and the link are all written', async () => {
        // Arrange
        const ctx = await seedConflictedMerge(true);
        const root = ctx.layout.workDir;
        const sut = mergeRun;

        // Act
        await sut(ctx, { rev: 'theirs', author });

        // Assert
        expect(await ctx.fs.readUtf8(`${root}/file.txt`)).toContain('<<<<<<<');
        expect(await ctx.fs.readUtf8(`${root}/a/f`)).toBe('payload');
        expect(await ctx.fs.readlink(`${root}/A`)).toBe(OUTSIDE);
      });
    });
  });

  describe('Given a conflicted merge whose writes contain no symlink', () => {
    describe('When it writes the working tree', () => {
      it('Then the wave makes no directory of its own', async () => {
        // Arrange
        const ctx = await seedConflictedMerge(false);
        const mkdirSpy = vi.spyOn(ctx.fs, 'mkdir');
        const sut = mergeRun;

        // Act
        await sut(ctx, { rev: 'theirs', author });

        // Assert
        const worktreeDirectories = mkdirSpy.mock.calls
          .map(([path]) => path)
          .filter((path) => !path.startsWith(ctx.layout.gitDir));
        expect(worktreeDirectories).toEqual([]);
      });
    });
  });

  describe('Given a sequential route writing a symlink', () => {
    const spyOnScanners = (): ReturnType<typeof vi.fn>[] => {
      const created: ReturnType<typeof vi.fn>[] = [];
      const real = scannerMod.createLeadingPathScanner;
      vi.spyOn(scannerMod, 'createLeadingPathScanner').mockImplementation((ctx) => {
        const scanner = real(ctx);
        const invalidateAll = vi.fn(scanner.invalidateAll);
        created.push(invalidateAll);
        return { ...scanner, invalidateAll };
      });
      return created;
    };

    const treeOf = async (ctx: Context, rev: string): Promise<ObjectId> => {
      const id = (await resolveRef(ctx, rev as RefName)) as ObjectId;
      const object = await readObject(ctx, id);
      if (object.type !== 'commit') throw new Error('expected a commit');
      return object.data.tree;
    };

    describe('When applyMergeToWorktree writes the link', () => {
      it('Then every memoised verdict is dropped after it', async () => {
        // Arrange
        const ctx = await seedConflictedMerge(true);
        const invalidations = spyOnScanners();
        const input = {
          baseTree: undefined,
          oursTree: await treeOf(ctx, 'refs/heads/main'),
          theirsTree: await treeOf(ctx, 'refs/heads/theirs'),
          currentIndex: await readIndex(ctx),
        };
        const sut = applyMergeToWorktree;

        // Act
        await sut(ctx, input);

        // Assert
        expect(invalidations.flatMap((spy) => spy.mock.calls)).toHaveLength(1);
      });
    });

    describe('When applyMergeToWorktree writes a conflict whose sides are symlinks', () => {
      it('Then every memoised verdict is dropped after it', async () => {
        // Arrange
        const ctx = await seedSymlinkAddAddConflict();
        const invalidations = spyOnScanners();
        const input = {
          baseTree: undefined,
          oursTree: await treeOf(ctx, 'refs/heads/main'),
          theirsTree: await treeOf(ctx, 'refs/heads/theirs'),
          currentIndex: await readIndex(ctx),
        };
        const sut = applyMergeToWorktree;

        // Act
        await sut(ctx, input);

        // Assert
        expect(invalidations.flatMap((spy) => spy.mock.calls)).toHaveLength(1);
      });
    });

    describe('When stash apply restores an untracked symlink', () => {
      it('Then every memoised verdict is dropped after it', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/base.txt`, 'base');
        await add(ctx, ['base.txt']);
        await commit(ctx, { message: 'base', author });
        await ctx.fs.symlink('base.txt', `${ctx.layout.workDir}/L`);
        await stashPush(ctx, { includeUntracked: true });
        const invalidations = spyOnScanners();
        const sut = stashApply;

        // Act
        await sut(ctx);

        // Assert
        expect(await ctx.fs.readlink(`${ctx.layout.workDir}/L`)).toBe('base.txt');
        expect(invalidations.flatMap((spy) => spy.mock.calls)).toHaveLength(1);
      });
    });
  });
});
