import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { invalidateConfigCache } from '../../../../src/application/primitives/config-read.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { seedIndex } from './add-index-fixtures.js';
import { seedRepo } from './fixtures.js';

type Ctx = ReturnType<typeof createMemoryContext>;

const CHANGED = 'changed\n';
const CONE_B = '/*\n!/*/\n/b/\n';
const SPARSE_ON = '[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = true\n';

/** Cone /b/: "a/f" is outside the definition, carries no skip-worktree bit, and changed on disk. */
const sparseRepo = async (extraFiles: Record<string, string> = {}): Promise<Ctx> => {
  const ctx = createMemoryContext();
  await seedRepo(ctx, { workingTree: { 'a/f': CHANGED, 'b/f': 'b2\n', ...extraFiles } });
  await seedIndex(ctx, [
    { path: 'a/f', text: 'base\n' },
    { path: 'b/f', text: 'b\n' },
  ]);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, SPARSE_ON);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/info/sparse-checkout`, CONE_B);
  invalidateConfigCache(ctx);
  return ctx;
};

const blobOf = async (ctx: Ctx, path: string) =>
  (await readIndex(ctx)).entries.find((entry) => entry.path === path)?.id;

describe('add over an out-of-pattern entry without the bit', () => {
  describe('Given sparse on and an out-of-pattern entry without the bit whose file changed', () => {
    describe('When add names it as a literal', () => {
      it('Then it reports the literal in sparse and stages nothing', async () => {
        // Arrange
        const ctx = await sparseRepo();
        const before = await blobOf(ctx, 'a/f');
        const sut = add;

        // Act
        const result = await sut(ctx, ['a/f']);

        // Assert
        expect(result.sparse).toEqual(['a/f']);
        expect(result.modified).toEqual([]);
        expect(await blobOf(ctx, 'a/f')).toBe(before);
      });
    });

    describe('When add runs on the directory "a"', () => {
      it('Then it reports the pathspec as typed and stages nothing', async () => {
        // Arrange
        const ctx = await sparseRepo();
        const before = await blobOf(ctx, 'a/f');
        const sut = add;

        // Act
        const result = await sut(ctx, ['a']);

        // Assert
        expect(result.sparse).toEqual(['a']);
        expect(result.modified).toEqual([]);
        expect(await blobOf(ctx, 'a/f')).toBe(before);
      });
    });

    describe('When add runs on the glob "a/*"', () => {
      it('Then it reports the glob as typed and stages nothing', async () => {
        // Arrange
        const ctx = await sparseRepo();
        const before = await blobOf(ctx, 'a/f');
        const sut = add;

        // Act
        const result = await sut(ctx, ['a/*']);

        // Assert
        expect(result.sparse).toEqual(['a/*']);
        expect(result.modified).toEqual([]);
        expect(await blobOf(ctx, 'a/f')).toBe(before);
      });
    });

    describe('When add runs with all', () => {
      it('Then it stages the in-pattern file only and reports nothing', async () => {
        // Arrange
        const ctx = await sparseRepo();
        const before = await blobOf(ctx, 'a/f');
        const sut = add;

        // Act
        const result = await sut(ctx, [], { all: true });

        // Assert
        expect(result.sparse).toEqual([]);
        expect(result.modified).toEqual(['b/f']);
        expect(await blobOf(ctx, 'a/f')).toBe(before);
      });
    });

    describe('When add runs on the whole tree', () => {
      it('Then it stages the in-pattern file only and reports nothing', async () => {
        // Arrange
        const ctx = await sparseRepo();
        const before = await blobOf(ctx, 'a/f');
        const sut = add;

        // Act
        const result = await sut(ctx, ['.']);

        // Assert
        expect(result.sparse).toEqual([]);
        expect(result.modified).toEqual(['b/f']);
        expect(await blobOf(ctx, 'a/f')).toBe(before);
      });
    });

    describe('When add runs on a literal beside an in-pattern change', () => {
      it('Then it reports the literal and stages the other', async () => {
        // Arrange
        const ctx = await sparseRepo();
        const sut = add;

        // Act
        const result = await sut(ctx, ['a/f', 'b/f']);

        // Assert
        expect(result.sparse).toEqual(['a/f']);
        expect(result.modified).toEqual(['b/f']);
      });
    });

    describe('When add renormalizes the whole tree', () => {
      it('Then the out-of-pattern blob stays unchanged', async () => {
        // Arrange
        const ctx = await sparseRepo();
        const before = await blobOf(ctx, 'a/f');
        const sut = add;

        // Act
        const result = await sut(ctx, ['.'], { renormalize: true });

        // Assert
        expect(result.modified).not.toContain('a/f');
        expect(await blobOf(ctx, 'a/f')).toBe(before);
      });
    });
  });

  describe('Given sparse on and an untracked out-of-pattern file', () => {
    describe('When add names it', () => {
      it('Then it reports the path and adds nothing', async () => {
        // Arrange
        const ctx = await sparseRepo({ 'a/new': 'n\n' });
        const sut = add;

        // Act
        const result = await sut(ctx, ['a/new']);

        // Assert
        expect(result.sparse).toEqual(['a/new']);
        expect(result.added).toEqual([]);
        expect(await blobOf(ctx, 'a/new')).toBeUndefined();
      });
    });

    describe('When add runs with all', () => {
      it('Then it reports the path and adds nothing', async () => {
        // Arrange
        const ctx = await sparseRepo({ 'a/new': 'n\n' });
        const sut = add;

        // Act
        const result = await sut(ctx, [], { all: true });

        // Assert
        expect(result.sparse).toEqual(['a/new']);
        expect(result.added).toEqual([]);
        expect(await blobOf(ctx, 'a/new')).toBeUndefined();
      });
    });

    describe('When add names a tracked literal and the untracked file', () => {
      it('Then the pathspec report comes before the walk report', async () => {
        // Arrange
        const ctx = await sparseRepo({ 'a/new': 'n\n' });
        const sut = add;

        // Act
        const result = await sut(ctx, ['a/new', 'a/f']);

        // Assert
        expect(result.sparse).toEqual(['a/f', 'a/new']);
        expect(result.added).toEqual([]);
      });
    });
  });

  describe('Given sparse on and an in-pattern untracked file', () => {
    describe('When add runs with all', () => {
      it('Then it is added and nothing is reported', async () => {
        // Arrange
        const ctx = await sparseRepo({ 'b/new': 'n\n' });
        const sut = add;

        // Act
        const result = await sut(ctx, [], { all: true });

        // Assert
        expect(result.sparse).toEqual([]);
        expect(result.added).toEqual(['b/new']);
      });
    });
  });
});
