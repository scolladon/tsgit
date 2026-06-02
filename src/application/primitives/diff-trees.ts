import {
  detectRenames,
  diffTrees as domainDiffTrees,
  type TreeDiff,
} from '../../domain/diff/index.js';
import type { Tree } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { flattenTree } from './flatten-tree.js';
import { readTree } from './read-tree.js';
import type { DiffTreesInput, DiffTreesOptions } from './types.js';

export async function diffTrees(
  ctx: Context,
  a: DiffTreesInput,
  b: DiffTreesInput,
  options?: DiffTreesOptions,
): Promise<TreeDiff> {
  const [treeA, treeB] = await Promise.all([resolveInput(ctx, a), resolveInput(ctx, b)]);
  const raw =
    options?.recursive === true
      ? await diffRecursive(ctx, treeA, treeB)
      : domainDiffTrees(treeA, treeB);
  if (options?.detectRenames === true) {
    return detectRenames(raw, options.renameOptions);
  }
  return raw;
}

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
