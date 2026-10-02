/**
 * Resolve a commit-ish argument (as `merge` / `cherry-pick` accept it) to an
 * `ObjectId`: an exact 40-hex oid, else gitrevisions ref-DWIM (peeling annotated
 * tags), else an abbreviated oid via `resolveOidPrefix`. Extracted from `merge`
 * so both commands share one ladder.
 */
import { errorDataCode } from '../../../domain/error-data-code.js';
import { isOid, type ObjectId, type RefName } from '../../../domain/objects/index.js';
import { refNotFound } from '../../../domain/refs/error.js';
import { refCandidates } from '../../../domain/refs/index.js';
import type { Context } from '../../../ports/context.js';
import { resolveOidPrefix } from '../../primitives/resolve-oid-prefix.js';
import { resolveRefOrMissing, UNREADABLE_REF_CODES } from '../../primitives/resolve-ref.js';

/** What a candidate may fail with and still just not be this name: a ref
 *  that does not parse or resolve, or whose target object is absent. Anything
 *  else (an object source that cannot load) is a failure, not an absence. */
const isAbsentCandidate = (error: unknown): boolean => {
  const code = errorDataCode(error);
  return code === 'OBJECT_NOT_FOUND' || (code !== undefined && UNREADABLE_REF_CODES.has(code));
};

export const resolveCommitIsh = async (ctx: Context, target: string): Promise<ObjectId> => {
  // A full-width oid is an object name and wins over a same-named ref: without
  // this fast path, a branch literally named with that many hex chars would
  // DWIM to its tip on the slow ref ladder below. git resolves a full oid to
  // the object first.
  if (isOid(target, ctx.hashConfig)) return target as ObjectId;
  // gitrevisions ref-DWIM: try each candidate namespace in priority order,
  // peeling annotated tags to their underlying commit. resolveRefOrMissing
  // signals a miss by returning undefined, so a swept-past candidate costs
  // no thrown-and-caught REF_NOT_FOUND.
  for (const candidate of refCandidates(target)) {
    try {
      const id = await resolveRefOrMissing(ctx, candidate, { peel: true });
      if (id !== undefined) return id;
    } catch (error) {
      if (!isAbsentCandidate(error)) throw error;
    }
  }
  // Not a ref — try as an abbreviated object id (throws on ambiguity).
  const byPrefix = await resolveOidPrefix(ctx, target);
  if (byPrefix !== undefined) return byPrefix;
  throw refNotFound(target as RefName);
};
