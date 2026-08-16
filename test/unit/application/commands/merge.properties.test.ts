import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { writeNestedTree } from '../../../../src/application/commands/merge.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { treeDepthExceeded } from '../../../../src/domain/objects/error.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { FileMode, FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { type FlatPathEntrySpec, flatPathEntrySpecsArb } from '../primitives/arbitraries.js';
import { buildSeededContext } from '../primitives/fixtures.js';

interface LeafRecordOracle {
  readonly path: FilePath;
  readonly id: ObjectId;
  readonly mode: FileMode;
}

interface PartitionedLeavesOracle {
  readonly files: ReadonlyArray<LeafRecordOracle>;
  readonly subdirs: ReadonlyMap<string, ReadonlyArray<LeafRecordOracle>>;
}

const partitionByPrefixOracle = (
  leaves: ReadonlyArray<LeafRecordOracle>,
): PartitionedLeavesOracle => {
  const files: LeafRecordOracle[] = [];
  const subdirs = new Map<string, LeafRecordOracle[]>();
  for (const leaf of leaves) {
    const slashIndex = leaf.path.indexOf('/');
    if (slashIndex === -1) {
      files.push(leaf);
      continue;
    }
    const prefix = leaf.path.slice(0, slashIndex);
    const rest = leaf.path.slice(slashIndex + 1) as FilePath;
    const sub: LeafRecordOracle = { path: rest, id: leaf.id, mode: leaf.mode };
    const bucket = subdirs.get(prefix);
    if (bucket === undefined) subdirs.set(prefix, [sub]);
    else bucket.push(sub);
  }
  return { files, subdirs };
};

/**
 * Pre-rewrite depth cap: a module-local constant in the pre-rewrite
 * implementation, unrelated to `core.maxTreeDepth`. Kept only so the copied
 * oracle behaves exactly as the original code did — generated fixtures never
 * approach it (paths are at most 4 segments deep).
 */
const ORACLE_MAX_MERGE_TREE_DEPTH = 4096;

/**
 * Pre-rewrite recursive oracle for `writeNestedTree`, copied verbatim from
 * the implementation before this change's explicit-stack rewrite landed —
 * never re-implemented, never paraphrased, and never the production code
 * under test.
 */
const writeNestedTreeOracle = async (
  ctx: Context,
  leaves: ReadonlyArray<LeafRecordOracle>,
  depth = 0,
): Promise<ObjectId> => {
  if (depth > ORACLE_MAX_MERGE_TREE_DEPTH) throw treeDepthExceeded(depth);
  const { files, subdirs } = partitionByPrefixOracle(leaves);
  const subdirEntries = await Promise.all(
    Array.from(subdirs, async ([prefix, subLeaves]) => ({
      name: prefix as FilePath,
      id: await writeNestedTreeOracle(ctx, subLeaves, depth + 1),
      mode: FILE_MODE.DIRECTORY,
    })),
  );
  const fileEntries = files.map((f) => ({ name: f.path, id: f.id, mode: f.mode }));
  return writeTree(ctx, [...fileEntries, ...subdirEntries]);
};

const materializeLeaves = async (
  ctx: Context,
  specs: ReadonlyArray<FlatPathEntrySpec>,
): Promise<LeafRecordOracle[]> => {
  const leaves: LeafRecordOracle[] = [];
  for (const spec of specs) {
    const id = await writeObject(ctx, {
      type: 'blob',
      content: new TextEncoder().encode(spec.content),
      id: '' as ObjectId,
    });
    leaves.push({ path: spec.path as FilePath, id, mode: FILE_MODE.REGULAR });
  }
  return leaves;
};

describe('writeNestedTree properties', () => {
  describe('Given an arbitrary set of non-conflicting flat leaf paths', () => {
    describe('When written by the production (iterative) implementation', () => {
      it('Then it matches the pre-rewrite recursive oracle', async () => {
        // Arrange + Act + Assert
        await fc.assert(
          fc.asyncProperty(flatPathEntrySpecsArb(), async (specs) => {
            const ctx = await buildSeededContext();
            const leaves = await materializeLeaves(ctx, specs);

            const iterative = await writeNestedTree(ctx, leaves);
            const recursive = await writeNestedTreeOracle(ctx, leaves);

            expect(iterative).toBe(recursive);
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
