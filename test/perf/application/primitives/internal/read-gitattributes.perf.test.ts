import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { buildTreeAttributeProvider } from '../../../../../src/application/primitives/internal/read-gitattributes.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../../src/application/primitives/write-tree.js';
import { FILE_MODE, type FileMode } from '../../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/object-id.js';
import { type TreeEntry, treeEntry } from '../../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../../src/ports/context.js';

/**
 * Wall-clock scaling guard for attribute resolution over a deep tree. This is a
 * PERFORMANCE test: it asserts an elapsed-time budget, which is load-dependent
 * and therefore kept out of the `unit` project that Stryker mutates. The unit
 * suite pins the per-directory read count; this budget catches a regression
 * back to re-deriving every ancestor's stack per lookup, which is quadratic in
 * the depth.
 */
const DEPTH = 1_000;
const ATTRIBUTES_EVERY = 10;
const BUDGET_MS = 1_000;

const indexPath = (slashes: number): string =>
  Array.from({ length: slashes + 1 }, (_unused, level) => `d${level}`).join('/');

const putBlob = (ctx: Context, content: string): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode(content),
    id: '' as ObjectId,
  });

const putDeepTreeWithAttributes = async (ctx: Context): Promise<ObjectId> => {
  let child = await putBlob(ctx, 'leaf');
  let childMode: FileMode = FILE_MODE.REGULAR;
  for (let level = DEPTH; level >= 0; level -= 1) {
    const entries: TreeEntry[] = [treeEntry(childMode, `d${level}` as FilePath, child)];
    if (level % ATTRIBUTES_EVERY === 0) {
      const rules = await putBlob(ctx, `* merge=${level}\n`);
      entries.push(treeEntry(FILE_MODE.REGULAR, '.gitattributes' as FilePath, rules));
    }
    child = await writeTree(ctx, entries);
    childMode = FILE_MODE.DIRECTORY;
  }
  return child;
};

describe('buildTreeAttributeProvider (performance)', () => {
  describe('Given a tree a thousand directories deep with a .gitattributes in every tenth one', () => {
    describe('When each directory and the leaf are resolved in walk order', () => {
      it('Then the whole walk finishes inside a linear budget', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const tree = await putDeepTreeWithAttributes(ctx);
        const provider = await buildTreeAttributeProvider(ctx, tree);
        const sut = provider.sourcesForPath;

        // Act
        const start = performance.now();
        for (let slashes = 0; slashes < DEPTH; slashes += 1) {
          await sut(`${indexPath(slashes)}/` as FilePath);
        }
        const result = await sut(indexPath(DEPTH) as FilePath);
        const elapsedMs = performance.now() - start;

        // Assert
        expect(result.sources).toHaveLength(DEPTH / ATTRIBUTES_EVERY + 1);
        expect(elapsedMs).toBeLessThan(BUDGET_MS);
      });
    });
  });
});
