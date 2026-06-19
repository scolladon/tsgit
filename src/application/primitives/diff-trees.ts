import type { FlatTree } from '../../domain/diff/flat-tree.js';
import {
  computeStatFields,
  type DiffChange,
  diffTrees as domainDiffTrees,
  type LineKey,
  lineKeyIsActive,
  resolveLineKey,
  type StatDiffChange,
  type StatFields,
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
          options.renameOptions,
          await buildPreimage(ctx, treeA, options.renameOptions),
        )
      : rawDiff;

  const lineKey = resolveLineKey(options ?? {});
  const lineKeyActive = lineKeyIsActive(lineKey);
  const ignoreBlankLines = options?.ignoreBlankLines === true;
  const withStat = options?.withStat === true;

  if (lineKeyActive || withStat) {
    return applyLinePassAndStat(ctx, diff, lineKey, lineKeyActive, ignoreBlankLines, withStat);
  }
  return diff;
}

/**
 * Materialise blobs once, run the drop pass and stat in a single traversal.
 * When `lineKeyActive`, drops modify changes that yield zero real hunks under
 * the active line-key mode. When `withStat`, attaches per-file counts to
 * every surviving change. The stat and drop predicate share one
 * `computeStatFields` call per modify so drop and counts are mutually consistent.
 */
async function applyLinePassAndStat(
  ctx: Context,
  diff: TreeDiff,
  lineKey: LineKey,
  lineKeyActive: boolean,
  ignoreBlankLines: boolean,
  withStat: boolean,
): Promise<TreeDiff | StatTreeDiff> {
  const files = await materialisePatchFiles(ctx, diff.changes);
  const surviving: Array<DiffChange | StatDiffChange> = [];
  for (const file of files) {
    const stats = computeStatFields(
      file.oldContent ?? EMPTY,
      file.newContent ?? EMPTY,
      lineKeyActive
        ? { lineKey, ignoreBlankLines }
        : ignoreBlankLines
          ? { ignoreBlankLines }
          : undefined,
    );
    if (lineKeyActive && shouldDrop(file.change, stats)) continue;
    surviving.push(withStat ? { ...file.change, ...stats } : file.change);
  }
  return { changes: surviving };
}

/**
 * Drop predicate for the whitespace drop pass.
 * Only `modify` changes with zero added+deleted non-binary lines are dropped.
 * Type-changes, renames, copies, adds, and deletes are never dropped.
 * Binary modifies are never dropped (binary detection ignores whitespace flags).
 */
function shouldDrop(change: DiffChange, stats: StatFields): boolean {
  return change.type === 'modify' && stats.added === 0 && stats.deleted === 0 && !stats.binary;
}

/**
 * Build the flat preimage map for copies:'harder' — all tree-A paths become copy sources.
 * Returns undefined when copies:'harder' is not active or treeA is absent.
 */
async function buildPreimage(
  ctx: Context,
  treeA: Tree | undefined,
  renameOptions: RenameDetectOptions | undefined,
): Promise<FlatTree['entries'] | undefined> {
  if (renameOptions?.copies !== 'harder' || treeA === undefined) return undefined;
  const flat = await flattenTree(ctx, treeA);
  return flat.entries;
}

async function resolveInput(ctx: Context, input: DiffTreesInput): Promise<Tree | undefined> {
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
 * Flatten a tree to a full-path blob projection — `Tree` entries carry
 * full slash-separated names at the leaf blob mode. This reproduces git's
 * recursive diff order: directories sort with a trailing `/`, so raw full-path
 * byte sort matches a recursive walk. The projection is diff-only and is never
 * serialised — its slash-bearing names would be rejected by the tree serializer.
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
