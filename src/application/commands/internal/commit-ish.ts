/**
 * Resolve a commit-ish argument (as `merge` / `cherry-pick` accept it) to an
 * `ObjectId`: an exact 40-hex oid, else gitrevisions ref-DWIM (peeling annotated
 * tags), else an abbreviated oid via `resolveOidPrefix`. Extracted from `merge`
 * so both commands share one ladder. The first candidate that names an object wins
 * and its faults propagate, as git's `repo_get_oid` does.
 */
import { errorDataCode } from '../../../domain/error-data-code.js';
import { isOid, type ObjectId, type RefName } from '../../../domain/objects/index.js';
import { refNotFound } from '../../../domain/refs/error.js';
import type { Context } from '../../../ports/context.js';
import { peelChain, tagHop } from '../../primitives/internal/peel-chain.js';
import { readObject } from '../../primitives/read-object.js';
import { resolveOidPrefix } from '../../primitives/resolve-oid-prefix.js';
import { type RefCandidateOutcome, readRefCandidate } from '../../primitives/resolve-ref.js';
import { nthPriorCheckout } from './prior-checkout.js';
import {
  resolveRefLadder,
  resolveSubstitutedRefLadder,
  warnIfRefNamesObjectId,
} from './refname-ambiguity.js';

type NamedBy = 'object-name' | 'ref';

interface Named {
  readonly id: ObjectId;
  readonly namedBy: NamedBy;
}

const OBJECT_READ_FAULT_CODES: ReadonlySet<string> = new Set([
  'OBJECT_NOT_FOUND',
  'INVALID_OBJECT_ID',
]);

/** An object that is absent or whose id does not parse: what a corrupt candidate's read fails with. */
export const isObjectReadFault = (error: unknown): boolean => {
  const code = errorDataCode(error);
  return code !== undefined && OBJECT_READ_FAULT_CODES.has(code);
};

const unpeeledCandidate =
  (ctx: Context) =>
  (candidate: RefName | 'HEAD'): Promise<RefCandidateOutcome> =>
    readRefCandidate(ctx, candidate);

const objectName = (id: string): Named => ({ id: id as ObjectId, namedBy: 'object-name' });

const refName = (id: ObjectId): Named => ({ id, namedBy: 'ref' });

const resolveNamed = async (ctx: Context, target: string): Promise<Named> => {
  // A full-width oid is an object name and wins over a same-named ref: without
  // this fast path, a branch literally named with that many hex chars would
  // DWIM to its tip on the slow ref ladder below. git resolves a full oid to
  // the object first, warning when a ref shares the name.
  if (isOid(target, ctx.hashConfig)) {
    await warnIfRefNamesObjectId(ctx, target, unpeeledCandidate(ctx));
    return objectName(target);
  }
  const prior = await nthPriorCheckout(ctx, target);
  if (prior !== undefined) return resolvePriorCheckout(ctx, target, prior);
  // gitrevisions ref-DWIM: each candidate namespace in priority order.
  const byRef = await resolveRefLadder(ctx, target, unpeeledCandidate(ctx));
  if (byRef !== undefined) return refName(byRef);
  // Not a ref — try as an abbreviated object id (throws on ambiguity).
  const byPrefix = await resolveOidPrefix(ctx, target);
  if (byPrefix !== undefined) return objectName(byPrefix);
  throw refNotFound(target as RefName);
};

/** git's `repo_get_oid`: the winning candidate's own object, never peeled. */
export const resolveCommitIshObject = async (ctx: Context, target: string): Promise<ObjectId> =>
  (await resolveNamed(ctx, target)).id;

/** The winning candidate peeled through its annotated-tag chain when a ref named it. */
export const resolveCommitIsh = async (ctx: Context, target: string): Promise<ObjectId> => {
  const { id, namedBy } = await resolveNamed(ctx, target);
  if (namedBy === 'object-name') return id;
  return (await peelChain(ctx, id, readObject, tagHop)).id;
};

/** `@{-<n>}`: a detached prior checkout is its object id, a branch is read
 *  through the ref ladder alone, the ambiguity judged under `target`. */
const resolvePriorCheckout = async (
  ctx: Context,
  target: string,
  prior: string,
): Promise<Named> => {
  if (isOid(prior, ctx.hashConfig)) return objectName(prior);
  const byRef = await resolveSubstitutedRefLadder(ctx, target, prior, unpeeledCandidate(ctx));
  if (byRef === undefined) throw refNotFound(target as RefName);
  return refName(byRef);
};
