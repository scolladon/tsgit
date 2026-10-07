import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { archive } from '../../../../src/application/commands/archive.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { FILE_MODE, type FileMode } from '../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/object-id.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../src/ports/context.js';

/**
 * Wall-clock scaling guard for archive's held-back directory queue. This is a
 * PERFORMANCE test: it asserts an elapsed-time budget, which is load-dependent
 * and therefore kept out of the `unit` project that Stryker mutates. The unit
 * suite pins the entry order; this budget catches a regression to a queue
 * trim or attribute lookup that walks every ancestor again per entry, which is
 * quadratic in the depth.
 */
const DEPTH = 1_000;
const BUDGET_MS = 1_000;

const buildTreeChain = async (ctx: Context): Promise<ObjectId> => {
  let child = await writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode('leaf'),
    id: '' as ObjectId,
  });
  let childMode: FileMode = FILE_MODE.REGULAR;
  for (let level = DEPTH; level >= 0; level -= 1) {
    child = await writeTree(ctx, [treeEntry(childMode, `d${level}` as FilePath, child)]);
    childMode = FILE_MODE.DIRECTORY;
  }
  return child;
};

describe('archive (performance)', () => {
  describe('Given a tree chain a thousand directories deep', () => {
    describe('When archive iterates all entries', () => {
      it('Then the whole stream drains inside a linear budget', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
        const treeish = await buildTreeChain(ctx);
        const sut = archive;

        // Act
        const start = performance.now();
        const { entries } = await sut(ctx, { treeish });
        let count = 0;
        for await (const _entry of entries) count += 1;
        const elapsedMs = performance.now() - start;

        // Assert
        expect(count).toBe(DEPTH + 1);
        expect(elapsedMs).toBeLessThan(BUDGET_MS);
      });
    });
  });
});
