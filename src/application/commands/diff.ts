import type { TreeDiff } from '../../domain/diff/index.js';
import type { ObjectId } from '../../domain/objects/index.js';
import { validateRefName } from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import { diffTrees } from '../primitives/diff-trees.js';
import { readObject } from '../primitives/read-object.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { assertRepository } from './internal/repo-state.js';

export interface DiffOptions {
  /** Resolve to a tree. Accepts ref name, oid, or 'HEAD'. */
  readonly from?: string;
  readonly to?: string;
  readonly detectRenames?: boolean;
}

/**
 * Diff two tree-like targets and return the resulting `TreeDiff`. When `from`
 * is omitted, defaults to HEAD's tree; when `to` is omitted, defaults to
 * `undefined` (interpreted by `diffTrees` as the empty tree).
 */
export const diff = async (ctx: Context, opts: DiffOptions = {}): Promise<TreeDiff> => {
  await assertRepository(ctx);
  const from = await resolveTreeId(ctx, opts.from ?? 'HEAD');
  const to = opts.to !== undefined ? await resolveTreeId(ctx, opts.to) : undefined;
  return diffTrees(ctx, from, to, opts.detectRenames === true ? { detectRenames: true } : {});
};

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
