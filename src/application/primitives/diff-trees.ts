import {
  computeStatFields,
  type DiffChange,
  diffTrees as domainDiffTrees,
  type StatDiffChange,
  type StatTreeDiff,
  type TreeDiff,
} from '../../domain/diff/index.js';
import type { RenameDetectOptions } from '../../domain/diff/rename-detect.js';
import type { Tree } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { detectSimilarityRenames } from './detect-similarity-renames.js';
import { flattenTree } from './flatten-tree.js';
import { materialisePatchFiles } from './materialise-patch-files.js';
import { readTree } from './read-tree.js';
import type { DiffTreesInput, DiffTreesOptions } from './types.js';

const EMPTY = new Uint8Array(0);

export function diffTrees(
  ctx: Context,
  a: DiffTreesInput,
  b: DiffTreesInput,
  options: DiffTreesOptions & { withStat: true },
): Promise<StatTreeDiff>;
export function diffTrees(
  ctx: Context,
  a: DiffTreesInput,
  b: DiffTreesInput,
  options?: DiffTreesOptions,
): Promise<TreeDiff>;
export async function diffTrees(
  ctx: Context,
  a: DiffTreesInput,
  b: DiffTreesInput,
  options?: DiffTreesOptions,
): Promise<TreeDiff | StatTreeDiff> {
  const [treeA, treeB] = await Promise.all([resolveInput(ctx, a), resolveInput(ctx, b)]);
  const rawDiff =
    options?.recursive === true
      ? await diffRecursive(ctx, treeA, treeB)
      : domainDiffTrees(treeA, treeB);
  const diff =
    options?.detectRenames === true
      ? await detectSimilarityRenames(
          ctx,
          rawDiff,
          await buildRenameOptions(ctx, treeA, options.renameOptions),
        )
      : rawDiff;
  if (options?.withStat === true) {
    return attachStats(ctx, diff);
  }
  return diff;
}

/**
 * Thread rename options through, adding the flat preimage map when copies:'harder'
 * is active. The preimage is built from treeA via flattenTree (same walk used by
 * the recursive diff path) and passed so the primitive can widen copy sources to
 * all tree-A paths without a second tree read.
 */
async function buildRenameOptions(
  ctx: Context,
  treeA: Tree | undefined,
  renameOptions: RenameDetectOptions | undefined,
): Promise<RenameDetectOptions | undefined> {
  if (renameOptions?.copies !== 'harder' || treeA === undefined) return renameOptions;
  const flat = await flattenTree(ctx, treeA);
  return { ...renameOptions, preimage: flat.entries };
}

/**
 * Hydrate each change with its line counts. Reads blob contents (via
 * `materialisePatchFiles`) and runs the line diff per file — the line-level cost
 * the tree-level path avoids.
 */
async function attachStats(ctx: Context, diff: TreeDiff): Promise<StatTreeDiff> {
  const files = await materialisePatchFiles(ctx, diff.changes);
  const changes = files.map(
    (file): StatDiffChange => withStatFields(file.change, file.oldContent, file.newContent),
  );
  return { changes };
}

const withStatFields = (
  change: DiffChange,
  oldContent: Uint8Array | undefined,
  newContent: Uint8Array | undefined,
): StatDiffChange => ({
  ...change,
  ...computeStatFields(oldContent ?? EMPTY, newContent ?? EMPTY),
});

async function resolveInput(ctx: Context, input: DiffTreesInput): Promise<Tree | undefined> {
  // Stryker disable next-line ConditionalExpression: equivalent — when input is undefined, skipping this guard falls through to `return input`, which is also undefined
  if (input === undefined) return undefined;
  if (typeof input === 'string') {
    return readTree(ctx, input);
  }
  return input;
}

async function diffRecursive(
  ctx: Context,
  a: Tree | undefined,
  b: Tree | undefined,
): Promise<TreeDiff> {
  const [oldTree, newTree] = await Promise.all([blobProjection(ctx, a), blobProjection(ctx, b)]);
  return domainDiffTrees(oldTree, newTree);
}

/**
 * Flatten a tree to a full-path blob *projection* — a `Tree` whose entries carry
 * full slash-separated names and the leaf blob mode. Classifying these
 * reproduces git's recursive diff order: a directory sorts as if it had a
 * trailing `/`, so a raw full-path byte sort matches the recursive walk. The
 * projection is diff-only and is never serialised — its slash-bearing names
 * would be rejected by the tree serializer, which it never reaches.
 */
async function blobProjection(ctx: Context, tree: Tree | undefined): Promise<Tree | undefined> {
  if (tree === undefined) return undefined;
  const flat = await flattenTree(ctx, tree);
  const entries = Array.from(flat.entries, ([name, entry]) => ({
    name,
    mode: entry.mode,
    id: entry.id,
  }));
  return { type: 'tree', id: tree.id, entries };
}
