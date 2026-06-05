import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../../src/application/commands/add.js';
import { commit } from '../../../../../src/application/commands/commit.js';
import { init } from '../../../../../src/application/commands/init.js';
import { assertCleanWorkTree } from '../../../../../src/application/commands/internal/clean-work-tree.js';
import { readIndex } from '../../../../../src/application/primitives/read-index.js';
import { writeTree } from '../../../../../src/application/primitives/write-tree.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { GitIndex, IndexEntry } from '../../../../../src/domain/git-index/index.js';
import { STAGE0_FLAGS, serializeIndex } from '../../../../../src/domain/git-index/index.js';
import { hexToBytes } from '../../../../../src/domain/objects/encoding.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type {
  AuthorIdentity,
  FilePath,
  ObjectId,
} from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const AUTHOR: AuthorIdentity = { name: 'T', email: 't@x', timestamp: 1, timezoneOffset: '+0000' };
const work = (ctx: Context, name: string): string => `${ctx.layout.workDir}/${name}`;

/** A clean repo with one committed file; returns ctx + the HEAD tree oid. */
const seedClean = async (
  name: string,
  content: string,
): Promise<{ ctx: Context; headTree: ObjectId }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(work(ctx, name), content);
  await add(ctx, [name]);
  const { tree } = await commit(ctx, { message: 'init', author: AUTHOR });
  return { ctx, headTree: tree };
};

const codeOf = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
    return undefined;
  } catch (err) {
    return (err as TsgitError).data.code;
  }
};

const stageEntry = (path: string, id: ObjectId, stage: 0 | 1 | 2 | 3): IndexEntry => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode: FILE_MODE.REGULAR,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id,
  flags: { ...STAGE0_FLAGS, stage },
  path: path as FilePath,
});

const writeFramedIndex = async (
  ctx: Context,
  entries: ReadonlyArray<IndexEntry>,
): Promise<void> => {
  const index: GitIndex = { version: 2, entries, extensions: [], trailerSha: new Uint8Array(0) };
  const body = serializeIndex(index);
  const trailer = hexToBytes(await ctx.hash.hashHex(body));
  const framed = new Uint8Array(body.length + 20);
  framed.set(body);
  framed.set(trailer, body.length);
  await ctx.fs.write(`${ctx.layout.gitDir}/index`, framed);
};

describe('assertCleanWorkTree', () => {
  describe('Given a clean working tree and index matching HEAD', () => {
    describe('When asserted', () => {
      it('Then it passes', async () => {
        // Arrange
        const { ctx, headTree } = await seedClean('a.txt', 'hello\n');

        // Act + Assert (does not throw)
        await expect(assertCleanWorkTree(ctx, headTree)).resolves.toBeUndefined();
      });
    });
  });

  describe('Given a staged change (index differs from HEAD)', () => {
    describe('When asserted', () => {
      it('Then throws WORKING_TREE_DIRTY listing the path', async () => {
        // Arrange
        const { ctx, headTree } = await seedClean('a.txt', 'hello\n');
        await ctx.fs.writeUtf8(work(ctx, 'a.txt'), 'changed\n');
        await add(ctx, ['a.txt']);

        // Act
        let caught: TsgitError | undefined;
        try {
          await assertCleanWorkTree(ctx, headTree);
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data.code).toBe('WORKING_TREE_DIRTY');
        if (caught?.data.code === 'WORKING_TREE_DIRTY') {
          expect(caught.data.paths).toContain('a.txt');
        }
      });
    });
  });

  describe('Given a staged addition (path absent from HEAD)', () => {
    describe('When asserted', () => {
      it('Then throws WORKING_TREE_DIRTY', async () => {
        // Arrange — a second file staged but not committed
        const { ctx, headTree } = await seedClean('a.txt', 'hello\n');
        await ctx.fs.writeUtf8(work(ctx, 'b.txt'), 'new\n');
        await add(ctx, ['b.txt']);

        // Act
        const code = await codeOf(() => assertCleanWorkTree(ctx, headTree));

        // Assert
        expect(code).toBe('WORKING_TREE_DIRTY');
      });
    });
  });

  describe('Given a staged mode change (same content, different mode)', () => {
    describe('When asserted', () => {
      it('Then throws WORKING_TREE_DIRTY on the mode difference alone', async () => {
        // Arrange — index entry keeps the committed blob id but flips to
        // executable; skip-worktree so the on-disk (unstaged) check is bypassed,
        // isolating the staged mode comparison.
        const { ctx, headTree } = await seedClean('a.txt', 'hello\n');
        const index = await readIndex(ctx);
        const id = index.entries.find((e) => e.path === 'a.txt')?.id as ObjectId;
        const entry: IndexEntry = {
          ...stageEntry('a.txt', id, 0),
          mode: FILE_MODE.EXECUTABLE,
          flags: { ...STAGE0_FLAGS, skipWorktree: true },
        };
        await writeFramedIndex(ctx, [entry]);

        // Act
        const code = await codeOf(() => assertCleanWorkTree(ctx, headTree));

        // Assert
        expect(code).toBe('WORKING_TREE_DIRTY');
      });
    });
  });

  describe('Given a staged deletion (path in HEAD, removed from index)', () => {
    describe('When asserted', () => {
      it('Then throws WORKING_TREE_DIRTY', async () => {
        // Arrange — committed file, then unstage it (drop from index)
        const { ctx, headTree } = await seedClean('a.txt', 'hello\n');
        await writeFramedIndex(ctx, []);

        // Act
        const code = await codeOf(() => assertCleanWorkTree(ctx, headTree));

        // Assert
        expect(code).toBe('WORKING_TREE_DIRTY');
      });
    });
  });

  describe('Given an unstaged change (working tree differs from index)', () => {
    describe('When asserted', () => {
      it('Then throws WORKING_TREE_DIRTY', async () => {
        // Arrange
        const { ctx, headTree } = await seedClean('a.txt', 'hello\n');
        await ctx.fs.writeUtf8(work(ctx, 'a.txt'), 'dirty\n');

        // Act
        const code = await codeOf(() => assertCleanWorkTree(ctx, headTree));

        // Assert
        expect(code).toBe('WORKING_TREE_DIRTY');
      });
    });
  });

  describe('Given an unmerged index entry (stage > 0)', () => {
    describe('When asserted', () => {
      it('Then throws WORKING_TREE_DIRTY', async () => {
        // Arrange — empty HEAD tree + a stage-1 entry
        const ctx = createMemoryContext();
        await init(ctx);
        const emptyTree = await writeTree(ctx, []);
        await writeFramedIndex(ctx, [stageEntry('c.txt', 'c'.repeat(40) as ObjectId, 1)]);

        // Act
        const code = await codeOf(() => assertCleanWorkTree(ctx, emptyTree));

        // Assert
        expect(code).toBe('WORKING_TREE_DIRTY');
      });
    });
  });

  describe('Given a skip-worktree entry whose file is absent', () => {
    describe('When asserted', () => {
      it('Then it passes (the sparse-excluded path is not compared on disk)', async () => {
        // Arrange — commit a file, mark its entry skip-worktree, remove the file
        const { ctx, headTree } = await seedClean('a.txt', 'hello\n');
        const { entries } = await readIndex(ctx);
        await writeFramedIndex(
          ctx,
          entries.map((entry) =>
            entry.path === ('a.txt' as FilePath)
              ? { ...entry, flags: { ...entry.flags, skipWorktree: true } }
              : entry,
          ),
        );
        await ctx.fs.rm(work(ctx, 'a.txt'));

        // Act + Assert (does not throw — id still matches HEAD, disk skipped)
        await expect(assertCleanWorkTree(ctx, headTree)).resolves.toBeUndefined();
      });
    });
  });
});
