import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { archive } from '../../../../src/application/commands/archive.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { FILE_MODE, type FileMode } from '../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/object-id.js';
import { type TreeEntry, treeEntry } from '../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../src/ports/context.js';

/**
 * Wall-clock scaling guard for archive's held-back directory queue. This is a
 * PERFORMANCE test: it asserts an elapsed-time budget, which is load-dependent
 * and therefore kept out of the `unit` project that Stryker mutates. The unit
 * suite pins the entry order; this budget catches a regression to a queue
 * trim or attribute lookup that walks every ancestor again per entry, which is
 * quadratic in the depth — and, with attributes files along the chain, a rule
 * evaluation whose cost grows with the directories above the entry.
 */
const DEPTH = 1_000;
const BUDGET_MS = 1_000;

const ATTRIBUTE_SPACING = 10;
const ATTRIBUTE_FILES = DEPTH / ATTRIBUTE_SPACING + 1;

type LevelEntries = (level: number) => ReadonlyArray<TreeEntry>;

const noEntries: LevelEntries = () => [];

const putBlob = (ctx: Context, text: string): Promise<ObjectId> =>
  writeObject(ctx, { type: 'blob', content: new TextEncoder().encode(text), id: '' as ObjectId });

const buildTreeChain = async (ctx: Context, extraAt: LevelEntries): Promise<ObjectId> => {
  let child = await putBlob(ctx, 'leaf');
  let childMode: FileMode = FILE_MODE.REGULAR;
  for (let level = DEPTH; level >= 0; level -= 1) {
    const link = treeEntry(childMode, `d${level}` as FilePath, child);
    child = await writeTree(ctx, [link, ...extraAt(level)]);
    childMode = FILE_MODE.DIRECTORY;
  }
  return child;
};

/** A `.gitattributes` in every tenth directory, with a rule no entry matches. */
const attributesEveryTenthLevel = async (ctx: Context): Promise<LevelEntries> => {
  const attributes = await putBlob(ctx, '*.bin export-ignore\n');
  const file = treeEntry(FILE_MODE.REGULAR, '.gitattributes' as FilePath, attributes);
  return (level) => (level % ATTRIBUTE_SPACING === 0 ? [file] : []);
};

const drain = async (ctx: Context, treeish: ObjectId) => {
  const start = performance.now();
  const { entries } = await archive(ctx, { treeish });
  let count = 0;
  for await (const _entry of entries) count += 1;
  return { count, elapsedMs: performance.now() - start };
};

const createRepoContext = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  return ctx;
};

describe('archive (performance)', () => {
  describe('Given a tree chain a thousand directories deep', () => {
    describe('When archive iterates all entries', () => {
      it('Then the whole stream drains inside a linear budget', async () => {
        // Arrange
        const ctx = await createRepoContext();
        const treeish = await buildTreeChain(ctx, noEntries);
        const sut = drain;

        // Act
        const result = await sut(ctx, treeish);

        // Assert
        expect(result.count).toBe(DEPTH + 1);
        expect(result.elapsedMs).toBeLessThan(BUDGET_MS);
      });
    });
  });

  describe('Given the same chain with a .gitattributes in every tenth directory', () => {
    describe('When archive iterates all entries', () => {
      it('Then resolving each entry over its ancestors stays inside the same budget', async () => {
        // Arrange
        const ctx = await createRepoContext();
        const treeish = await buildTreeChain(ctx, await attributesEveryTenthLevel(ctx));
        const sut = drain;

        // Act
        const result = await sut(ctx, treeish);

        // Assert
        expect(result.count).toBe(DEPTH + 1 + ATTRIBUTE_FILES);
        expect(result.elapsedMs).toBeLessThan(BUDGET_MS);
      });
    });
  });
});
