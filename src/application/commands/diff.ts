import type { StatTreeDiff, TreeDiff } from '../../domain/diff/index.js';
import type { ObjectId } from '../../domain/objects/index.js';
import { validateRefName } from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import { diffTrees } from '../primitives/diff-trees.js';
import { readObject } from '../primitives/read-object.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import type { DiffTreesOptions } from '../primitives/types.js';
import { assertRepository } from './internal/repo-state.js';

export interface DiffOptions {
  /** Resolve to a tree. Accepts ref name, oid, or 'HEAD'. */
  readonly from?: string;
  readonly to?: string;
  readonly detectRenames?: boolean;
  /**
   * Recurse into sub-directories (`git diff-tree -r`), surfacing nested blobs as
   * full-path changes instead of one change per top-level sub-tree. Default `false`.
   */
  readonly recursive?: boolean;
  /**
   * Attach per-file line counts (`added` / `deleted` / `binary`) to each change —
   * the data half of git's `--numstat`. Off by default (tree-level, no blob reads).
   */
  readonly withStat?: boolean;
}

/**
 * Structured patch view: the unified-diff text bundled with the `TreeDiff`.
 *
 * Internal only — no command returns it. `show` surfaces the structured diff
 * (`TreeDiff`); the unified-diff *text* is reconstructed by callers / interop
 * tests via the `renderPatch` domain serializer.
 */
export interface PatchResult {
  readonly format: 'patch';
  readonly text: string;
  readonly diff: TreeDiff;
}

/**
 * Diff two tree-like targets, returning the structured `TreeDiff`. Pass
 * `withStat: true` to attach per-file line counts (a `StatTreeDiff`). Rendering
 * the diff as a unified patch is the caller's concern.
 */
export function diff(ctx: Context, opts: DiffOptions & { withStat: true }): Promise<StatTreeDiff>;
export function diff(ctx: Context, opts?: DiffOptions): Promise<TreeDiff>;
export async function diff(ctx: Context, opts: DiffOptions = {}): Promise<TreeDiff | StatTreeDiff> {
  await assertRepository(ctx);
  const from = await resolveTreeId(ctx, opts.from ?? 'HEAD');
  const to = opts.to !== undefined ? await resolveTreeId(ctx, opts.to) : undefined;
  const treeOptions: DiffTreesOptions = {
    ...(opts.detectRenames === true ? { detectRenames: true } : {}),
    ...(opts.recursive === true ? { recursive: true } : {}),
    ...(opts.withStat === true ? { withStat: true } : {}),
  };
  return diffTrees(ctx, from, to, treeOptions);
}

const resolveTreeId = async (ctx: Context, target: string): Promise<ObjectId> => {
  // `validateRefName` is the identity for already-valid names (`'HEAD'`
  // included), so a separate HEAD short-circuit would be redundant.
  const id = /^[0-9a-f]{40}$/.test(target)
    ? (target as ObjectId)
    : await resolveRef(ctx, validateRefName(target));
  const obj = await readObject(ctx, id);
  if (obj.type === 'commit') return obj.data.tree;
  // A non-commit target (tree, blob, tag) is used verbatim; `diffTrees` is the
  // single place that validates the resolved id is tree-shaped.
  return id;
};
