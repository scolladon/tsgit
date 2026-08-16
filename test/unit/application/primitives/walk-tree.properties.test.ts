import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { readObject } from '../../../../src/application/primitives/read-object.js';
import type { WalkTreeEntry } from '../../../../src/application/primitives/types.js';
import {
  exceedsMaxTreeDepth,
  exceedsMaxTreeEntries,
} from '../../../../src/application/primitives/validators.js';
import { walkTree } from '../../../../src/application/primitives/walk-tree.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { operationAborted } from '../../../../src/domain/error.js';
import {
  treeCycleDetected,
  treeDepthExceeded,
  treeEntryLimitExceeded,
  unexpectedObjectType,
} from '../../../../src/domain/objects/error.js';
import {
  FILE_MODE,
  type FileMode,
  type FilePath,
  isDirectory,
  type ObjectId,
  type Tree,
  type TreeEntry,
} from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { type TreeShapeEntry, treeShapeArb } from './arbitraries.js';
import { buildSeededContext } from './fixtures.js';

// ---------------------------------------------------------------------------
// Pre-rewrite recursive oracle for `walkTree`, copied verbatim from the
// implementation before this change's explicit-stack rewrite landed — never
// re-implemented, never paraphrased, and never the production code under
// test. `maxDepth`/`maxEntries` default to `Number.MAX_SAFE_INTEGER` rather
// than the (now-deleted) production defaults: every call in this file
// supplies both explicitly, so the default value itself is never exercised.
// ---------------------------------------------------------------------------

interface WalkConfigOracle {
  readonly ctx: Context;
  readonly recursive: boolean;
  readonly maxDepth: number;
  readonly maxEntries: number;
}

interface CounterOracle {
  value: number;
}

interface WalkTreeOracleOptions {
  readonly recursive?: boolean;
  readonly maxDepth?: number;
  readonly maxEntries?: number;
}

async function* walkTreeOracle(
  ctx: Context,
  treeIdOrObject: ObjectId | Tree,
  options?: WalkTreeOracleOptions,
): AsyncIterable<WalkTreeEntry> {
  const config: WalkConfigOracle = {
    ctx,
    recursive: options?.recursive ?? true,
    maxDepth: options?.maxDepth ?? Number.MAX_SAFE_INTEGER,
    maxEntries: options?.maxEntries ?? Number.MAX_SAFE_INTEGER,
  };
  const counter: CounterOracle = { value: 0 };
  const rootTree =
    typeof treeIdOrObject === 'string'
      ? await resolveTreeOracle(ctx, treeIdOrObject as ObjectId)
      : treeIdOrObject;
  yield* walkInternalOracle(config, counter, rootTree, '', 0, []);
}

async function* walkInternalOracle(
  config: WalkConfigOracle,
  counter: CounterOracle,
  tree: Tree,
  prefix: string,
  depth: number,
  stack: ObjectId[],
): AsyncIterable<WalkTreeEntry> {
  if (stack.includes(tree.id)) throw treeCycleDetected(tree.id);
  if (exceedsMaxTreeDepth(depth, config.maxDepth)) throw treeDepthExceeded(depth);
  const descentStack = [...stack, tree.id];
  for (const entry of tree.entries) {
    if (config.ctx.signal?.aborted) throw operationAborted();
    const path = (prefix === '' ? entry.name : `${prefix}/${entry.name}`) as FilePath;
    counter.value += 1;
    if (exceedsMaxTreeEntries(counter.value, config.maxEntries)) {
      throw treeEntryLimitExceeded(counter.value, config.maxEntries);
    }
    yield { path, id: entry.id, mode: entry.mode as FileMode };
    if (!shouldRecurseOracle(config.recursive, entry.mode)) continue;
    const subtreeObj = await readObject(config.ctx, entry.id);
    if (subtreeObj.type === 'tree') {
      yield* walkInternalOracle(config, counter, subtreeObj, path, depth + 1, descentStack);
    }
  }
}

function shouldRecurseOracle(recursive: boolean, mode: string): boolean {
  if (!recursive) return false;
  return isDirectory(mode as FileMode);
}

async function resolveTreeOracle(ctx: Context, id: ObjectId): Promise<Tree> {
  const obj = await readObject(ctx, id);
  if (obj.type !== 'tree') {
    throw unexpectedObjectType('tree', obj.type, id);
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Materialise a generated tree shape into real objects via the production
// writers (writeObject/writeTree) — content-addressing means the forced
// shared-subtree clone in `treeShapeArb` lands on the SAME oid as its
// original without any special-casing here.
// ---------------------------------------------------------------------------

const materializeTreeShapeEntries = async (
  ctx: Context,
  entries: ReadonlyArray<TreeShapeEntry>,
): Promise<TreeEntry[]> => {
  const out: TreeEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === 'blob') {
      const id = await writeObject(ctx, {
        type: 'blob',
        content: new TextEncoder().encode(entry.content),
        id: '' as ObjectId,
      });
      out.push({ name: entry.name as FilePath, id, mode: FILE_MODE.REGULAR });
      continue;
    }
    if (entry.kind === 'gitlink') {
      // walkTree never dereferences a gitlink's target (isDirectory rejects
      // mode 160000), so any well-formed oid works as the pinned commit.
      const id = await writeObject(ctx, {
        type: 'blob',
        content: new TextEncoder().encode(`gitlink:${entry.name}`),
        id: '' as ObjectId,
      });
      out.push({ name: entry.name as FilePath, id, mode: FILE_MODE.GITLINK });
      continue;
    }
    const childEntries = await materializeTreeShapeEntries(ctx, entry.children);
    const id = await writeTree(ctx, childEntries);
    out.push({ name: entry.name as FilePath, id, mode: FILE_MODE.DIRECTORY });
  }
  return out;
};

const collect = async (iter: AsyncIterable<WalkTreeEntry>): Promise<WalkTreeEntry[]> => {
  const out: WalkTreeEntry[] = [];
  for await (const entry of iter) out.push(entry);
  return out;
};

describe('walkTree properties', () => {
  describe('Given an arbitrary tree shape', () => {
    describe('When walked by the production (iterative) implementation', () => {
      it('Then it yields exactly the sequence the pre-rewrite recursive oracle yields', async () => {
        // Arrange + Act + Assert
        await fc.assert(
          fc.asyncProperty(treeShapeArb(), async (shape) => {
            const ctx = await buildSeededContext();
            const rootEntries = await materializeTreeShapeEntries(ctx, shape);
            const rootId = await writeTree(ctx, rootEntries);
            const options = { maxDepth: 1000, maxEntries: 1_000_000 };

            const iterative = await collect(walkTree(ctx, rootId, options));
            const recursive = await collect(walkTreeOracle(ctx, rootId, options));

            expect(iterative).toEqual(recursive);
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
