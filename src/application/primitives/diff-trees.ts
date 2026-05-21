import {
  detectRenames,
  diffTrees as domainDiffTrees,
  type TreeDiff,
} from '../../domain/diff/index.js';
import type { Tree } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { readTree } from './read-tree.js';
import type { DiffTreesInput, DiffTreesOptions } from './types.js';

export async function diffTrees(
  ctx: Context,
  a: DiffTreesInput,
  b: DiffTreesInput,
  options?: DiffTreesOptions,
): Promise<TreeDiff> {
  const [treeA, treeB] = await Promise.all([resolveInput(ctx, a), resolveInput(ctx, b)]);
  const raw = domainDiffTrees(treeA, treeB);
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
