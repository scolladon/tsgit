/**
 * git's `repo_in_merge_bases(a, b)` named for the question every caller
 * actually asks: is `ancestor` reachable from `descendant`. An oid compared
 * against itself answers true — it carries both of the paint's marks from the
 * start, the way git's own walk leaves it.
 */

import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { inMergeBases } from '../../primitives/merge-base.js';

export const isAncestor = (
  ctx: Context,
  ancestor: ObjectId,
  descendant: ObjectId,
): Promise<boolean> => inMergeBases(ctx, ancestor, descendant);
