/**
 * Resolve a commit-ish argument (as `merge` / `cherry-pick` accept it) to an
 * `ObjectId`: an exact 40-hex oid, else gitrevisions ref-DWIM (peeling annotated
 * tags), else an abbreviated oid via `resolveOidPrefix`. Extracted from `merge`
 * so both commands share one ladder.
 */
import type { ObjectId, RefName } from '../../../domain/objects/index.js';
import { refNotFound } from '../../../domain/refs/error.js';
import { refCandidates } from '../../../domain/refs/index.js';
import type { Context } from '../../../ports/context.js';
import { resolveOidPrefix } from '../../primitives/resolve-oid-prefix.js';
import { resolveRef } from '../../primitives/resolve-ref.js';

export const resolveCommitIsh = async (ctx: Context, target: string): Promise<ObjectId> => {
  // A full 40-hex is an object name and wins over a same-named ref: without this
  // fast path, a branch literally named with 40 hex chars would DWIM to its tip
  // on the slow ref ladder below. git resolves a full oid to the object first.
  if (/^[0-9a-f]{40}$/.test(target)) return target as ObjectId;
  // gitrevisions ref-DWIM: try each candidate namespace in priority order,
  // peeling annotated tags to their underlying commit.
  for (const candidate of refCandidates(target)) {
    try {
      return await resolveRef(ctx, candidate, { peel: true });
    } catch {
      // Not this candidate — fall through to the next namespace.
    }
  }
  // Not a ref — try as an abbreviated object id (throws on ambiguity).
  const byPrefix = await resolveOidPrefix(ctx, target);
  if (byPrefix !== undefined) return byPrefix;
  throw refNotFound(target as RefName);
};
