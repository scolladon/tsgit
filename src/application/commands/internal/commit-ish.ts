/**
 * Resolve a commit-ish argument (as `merge` / `cherry-pick` accept it) to an
 * `ObjectId`: an exact 40-hex oid, else gitrevisions ref-DWIM (peeling annotated
 * tags), else an abbreviated oid via `resolveOidPrefix`. Extracted from `merge`
 * so both commands share one ladder.
 */
import { errorDataCode } from '../../../domain/error-data-code.js';
import { isOid, type ObjectId, type RefName } from '../../../domain/objects/index.js';
import { refNotFound } from '../../../domain/refs/error.js';
import type { Context } from '../../../ports/context.js';
import { resolveOidPrefix } from '../../primitives/resolve-oid-prefix.js';
import { resolveRefOrMissing, UNREADABLE_REF_CODES } from '../../primitives/resolve-ref.js';
import { resolveRefLadder, warnIfRefNamesObjectId } from './refname-ambiguity.js';

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
  // the object first, warning when a ref shares the name.
  if (isOid(target, ctx.hashConfig)) {
    await warnIfRefNamesObjectId(ctx, target, peeledCandidate(ctx));
    return target as ObjectId;
  }
  // gitrevisions ref-DWIM: each candidate namespace in priority order,
  // peeling annotated tags to their underlying commit.
  const byRef = await resolveRefLadder(ctx, target, peeledCandidate(ctx));
  if (byRef !== undefined) return byRef;
  // Not a ref — try as an abbreviated object id (throws on ambiguity).
  const byPrefix = await resolveOidPrefix(ctx, target);
  if (byPrefix !== undefined) return byPrefix;
  throw refNotFound(target as RefName);
};

/** One candidate peeled to its commit, or `undefined` when it is not this name. */
const peeledCandidate =
  (ctx: Context) =>
  async (candidate: RefName | 'HEAD'): Promise<ObjectId | undefined> => {
    try {
      return await resolveRefOrMissing(ctx, candidate, { peel: true });
    } catch (error) {
      if (!isAbsentCandidate(error)) throw error;
      return undefined;
    }
  };
