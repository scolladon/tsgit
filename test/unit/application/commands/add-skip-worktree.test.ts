import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { serializeAndHash } from '../../../../src/application/primitives/internal/serialize-and-hash.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';
import { seedIndex } from './add-index-fixtures.js';
import { seedRepo } from './fixtures.js';

type Ctx = ReturnType<typeof createMemoryContext>;

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const CHANGED = 'changed\n';

/** Tracked `x.log` (skip-worktree, rewritten on disk), `k`, and `s.txt` (rewritten on disk). */
const sparseRepo = async (): Promise<Ctx> => {
  const ctx = createMemoryContext();
  await seedRepo(ctx, { workingTree: { 'x.log': CHANGED, k: 'k\n', 's.txt': 's2\n' } });
  await seedIndex(ctx, [
    { path: 'k', text: 'k\n' },
    { path: 's.txt', text: 's\n' },
    { path: 'x.log', text: 'old\n', skipWorktree: true },
  ]);
  return ctx;
};

const blobExists = async (ctx: Ctx, content: string) => {
  const { id } = await serializeAndHash(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: enc(content),
  });
  return ctx.fs.exists(`${ctx.layout.gitDir}/objects/${id.slice(0, 2)}/${id.slice(2)}`);
};

const entryOf = async (ctx: Ctx, path: string) =>
  (await readIndex(ctx)).entries.find((entry) => entry.path === path);

const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (err) {
    if (err instanceof TsgitError) return err.data;
    throw err;
  }
  return undefined;
};

describe('add over a skip-worktree entry', () => {
  describe('Given a skip-worktree file rewritten on disk', () => {
    describe('When the whole tree is added', () => {
      it('Then the entry keeps its bit and its blob', async () => {
        // Arrange
        const ctx = await sparseRepo();
        const before = await entryOf(ctx, 'x.log');
        const sut = add;

        // Act
        const result = await sut(ctx, ['.']);

        // Assert
        const after = await entryOf(ctx, 'x.log');
        expect(result.modified).toEqual(['s.txt']);
        expect(after?.flags.skipWorktree).toBe(true);
        expect(after?.id).toBe(before?.id);
        expect(await blobExists(ctx, CHANGED)).toBe(false);
      });
    });
  });

  describe('Given a skip-worktree file rewritten on disk', () => {
    describe('When a wildcard also reaching other files is added', () => {
      it('Then it reports nothing and the entry keeps its bit and its blob', async () => {
        // Arrange
        const ctx = await sparseRepo();
        const before = await entryOf(ctx, 'x.log');
        const sut = add;

        // Act
        const result = await sut(ctx, ['*']);

        // Assert
        const after = await entryOf(ctx, 'x.log');
        expect(result.modified).toEqual(['s.txt']);
        expect(after?.flags.skipWorktree).toBe(true);
        expect(after?.id).toBe(before?.id);
      });
    });
  });

  describe('Given a skip-worktree file absent from disk', () => {
    describe('When the whole tree is added', () => {
      it('Then its removal is not staged and the entry stays', async () => {
        // Arrange
        const ctx = await sparseRepo();
        await ctx.fs.rm(`${ctx.layout.workDir}/x.log`);
        const sut = add;

        // Act
        const result = await sut(ctx, ['.']);

        // Assert
        const after = await entryOf(ctx, 'x.log');
        expect(result.removed).toEqual([]);
        expect(after?.flags.skipWorktree).toBe(true);
      });
    });
  });

  describe('Given a wildcard that reaches only a skip-worktree entry', () => {
    describe('When added', () => {
      it('Then the spelling is reported and nothing is written', async () => {
        // Arrange
        const ctx = await sparseRepo();
        const before = await entryOf(ctx, 'x.log');
        const sut = add;

        // Act
        const result = await sut(ctx, ['*.log']);

        // Assert
        const after = await entryOf(ctx, 'x.log');
        expect(result.sparse).toEqual(['*.log']);
        expect(result.modified).toEqual([]);
        expect(after?.flags.skipWorktree).toBe(true);
        expect(after?.id).toBe(before?.id);
        expect(await blobExists(ctx, CHANGED)).toBe(false);
      });
    });
  });

  describe('Given a wildcard reaching only a skip-worktree entry beside another pathspec', () => {
    describe('When added', () => {
      it('Then only the sparse spelling is reported and the other is staged', async () => {
        // Arrange
        const ctx = await sparseRepo();
        const sut = add;

        // Act
        const result = await sut(ctx, ['*.log', 's.txt']);

        // Assert
        expect(result.sparse).toEqual(['*.log']);
        expect(result.modified).toEqual(['s.txt']);
      });
    });
  });

  describe('Given a prefix wildcard reaching only a skip-worktree entry', () => {
    describe('When added', () => {
      it('Then it is reported, also beside a wildcard that stages', async () => {
        // Arrange
        const ctx = await sparseRepo();
        const sut = add;

        // Act
        const result = await sut(ctx, ['x*', 's*']);

        // Assert
        expect(result.sparse).toEqual(['x*']);
        expect(result.modified).toEqual(['s.txt']);
      });
    });
  });

  describe('Given a sparse-only wildcard and a pathspec matching nothing', () => {
    describe('When added', () => {
      it('Then the unmatched pathspec is refused and nothing is written', async () => {
        // Arrange
        const ctx = await sparseRepo();
        const sut = add;

        // Act
        const data = await refusalOf(() => sut(ctx, ['x.log', 'nomatch*']));

        // Assert
        expect(data).toMatchObject({ code: 'PATHSPEC_NO_MATCH', pattern: 'nomatch*' });
        expect(await blobExists(ctx, 's2\n')).toBe(false);
      });
    });
  });

  describe('Given a skip-worktree file absent from disk', () => {
    describe('When it is added by name', () => {
      it('Then it is reported and kept', async () => {
        // Arrange
        const ctx = await sparseRepo();
        await ctx.fs.rm(`${ctx.layout.workDir}/x.log`);
        const sut = add;

        // Act
        const result = await sut(ctx, ['x.log']);

        // Assert
        expect(result.sparse).toEqual(['x.log']);
        expect(result.removed).toEqual([]);
        expect((await entryOf(ctx, 'x.log'))?.flags.skipWorktree).toBe(true);
      });
    });
  });

  describe('Given several pathspecs reaching only skip-worktree entries', () => {
    describe('When added with a duplicate', () => {
      it('Then they are reported in argument order, duplicates kept', async () => {
        // Arrange
        const ctx = await sparseRepo();
        const sut = add;

        // Act
        const result = await sut(ctx, ['x*', '*.log', 'x*']);

        // Assert
        expect(result.sparse).toEqual(['x*', '*.log', 'x*']);
      });
    });
  });

  describe('Given a tree holding only a skip-worktree entry', () => {
    describe('When the whole tree is added', () => {
      it('Then the whole-tree pathspec is reported and not refused', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, { workingTree: { 'x.log': CHANGED } });
        await seedIndex(ctx, [{ path: 'x.log', text: 'old\n', skipWorktree: true }]);
        const sut = add;

        // Act
        const result = await sut(ctx, ['.']);

        // Assert
        expect(result.sparse).toEqual(['.']);
        expect(result.modified).toEqual([]);
      });
    });
  });

  describe('Given a skip-worktree file rewritten on disk', () => {
    describe('When everything is added with all', () => {
      it('Then the entry keeps its bit and its blob', async () => {
        // Arrange
        const ctx = await sparseRepo();
        const before = await entryOf(ctx, 'x.log');
        const sut = add;

        // Act
        const result = await sut(ctx, [], { all: true });

        // Assert
        const after = await entryOf(ctx, 'x.log');
        expect(result.modified).toEqual(['s.txt']);
        expect(result.sparse).toEqual([]);
        expect(after?.flags.skipWorktree).toBe(true);
        expect(after?.id).toBe(before?.id);
      });
    });
  });

  describe('Given a skip-worktree file absent from disk', () => {
    describe('When everything is added with all', () => {
      it('Then its removal is not staged and the entry stays', async () => {
        // Arrange
        const ctx = await sparseRepo();
        await ctx.fs.rm(`${ctx.layout.workDir}/x.log`);
        const sut = add;

        // Act
        const result = await sut(ctx, [], { all: true });

        // Assert
        expect(result.removed).toEqual([]);
        expect((await entryOf(ctx, 'x.log'))?.flags.skipWorktree).toBe(true);
      });
    });
  });
});
