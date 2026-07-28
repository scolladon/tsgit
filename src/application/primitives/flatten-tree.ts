/**
 * Flatten a nested `Tree` into the `FlatTree` shape that the `mergeTrees`
 * domain primitive consumes.
 *
 * Delegates to `flattenRawTree`, a raw byte-cursor descent that walks tree
 * bytes directly instead of materialising a `Tree`/`TreeEntry` per level.
 * Accepts either an oid or an already-resolved `Tree` object — for a `Tree`
 * object the root is still read raw by its `id` (no redundant-root-read
 * shortcut; a hand-forged `Tree` whose `id` is absent throws
 * `OBJECT_NOT_FOUND`). Consumed by `merge.ts`'s clean-merge tree walk,
 * `rm`'s HEAD-vs-index staged-change check, and other worktree-facing
 * callers, so it is exported from the primitives barrel. The recursive
 * diff no longer flattens — it walks raw bytes directly.
 *
 * Pure with respect to the working tree — only reads git objects.
 */
import type { FlatTree } from '../../domain/diff/flat-tree.js';
import type { ObjectId, Tree } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { DEFAULT_FLATTEN_BOUNDS, flattenRawTree } from './internal/flatten-raw.js';

export const flattenTree = async (
  ctx: Context,
  treeIdOrObject: ObjectId | Tree,
): Promise<FlatTree> => flattenRawTree(ctx, treeIdOrObject, DEFAULT_FLATTEN_BOUNDS);
