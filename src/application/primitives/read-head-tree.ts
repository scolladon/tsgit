/**
 * Resolve HEAD's commit tree as a `FlatTree` (`path → { id, mode }`), or
 * `undefined` for an unborn HEAD (no commits yet). This is git's HEAD-tree side
 * of `diff-index` — the staged column compares it against the index.
 *
 * Tolerates an unborn HEAD by catching `REF_NOT_FOUND` (the symbolic ref points
 * at a branch with no commit). A HEAD that resolves to a non-commit object is a
 * corrupt repository and throws `unexpectedObjectType`.
 *
 * Pure with respect to the working tree — only reads git objects (via
 * `resolveRef` / `readObject` / `flattenTree`).
 */
import type { FlatTree } from '../../domain/diff/flat-tree.js';
import { TsgitError } from '../../domain/error.js';
import { unexpectedObjectType } from '../../domain/objects/error.js';
import type { Context } from '../../ports/context.js';
import { flattenTree } from './flatten-tree.js';
import { readObject } from './read-object.js';
import { resolveRef } from './resolve-ref.js';

export const readHeadTree = async (ctx: Context): Promise<FlatTree | undefined> => {
  const commitId = await resolveRef(ctx, 'HEAD').catch((err: unknown) => {
    if (err instanceof TsgitError && err.data.code === 'REF_NOT_FOUND') return undefined;
    throw err;
  });
  if (commitId === undefined) return undefined;
  const commit = await readObject(ctx, commitId);
  if (commit.type !== 'commit') {
    throw unexpectedObjectType('commit', commit.type, commitId);
  }
  return flattenTree(ctx, commit.data.tree);
};
