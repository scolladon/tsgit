import { applyGraftToData } from '../../../domain/commit/graft.js';
import type { CommitData } from '../../../domain/objects/commit.js';
import { unexpectedObjectType } from '../../../domain/objects/error.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readObject } from '../read-object.js';
import { loadShallowSet } from './shallow-set.js';

/**
 * Read a commit's data with shallow-boundary parents masked. The single
 * grafted `CommitData` reader shared by the history-rewriting porcelain
 * (via `commands/internal/history-rewrite.ts`) and `patch-id.ts` — one
 * definition for the `CommitData` shape, so the graft cannot be applied in
 * one of those consumers and forgotten in the other. (Sites that need a
 * whole `Commit` — show, rev-parse, name-rev, bisect-midpoint — graft with
 * `applyGraft` at their own read.)
 */
export const readCommitData = async (ctx: Context, id: ObjectId): Promise<CommitData> => {
  const obj = await readObject(ctx, id);
  if (obj.type !== 'commit') throw unexpectedObjectType('commit', obj.type, id);
  return applyGraftToData(id, obj.data, await loadShallowSet(ctx));
};
