/**
 * git's `repo_get_oid` ladder for a bare revision NAME — the shared half of
 * `rev-parse`'s base resolution, reused by every command that takes a name
 * argument (`checkout --detach`, `tag`'s target): a full-width object id, then
 * the gitrevisions candidate namespaces in priority order, then an
 * abbreviated object id. The miss is reported as `undefined`, not thrown —
 * each command owns the refusal git prints for its own argument.
 */
import {
  isOid,
  type ObjectId,
  ObjectId as ObjectIdFactory,
  type RefName,
} from '../../../domain/objects/index.js';
import { refCandidates } from '../../../domain/refs/index.js';
import type { Context } from '../../../ports/context.js';
import { type CandidateFilter, resolveOidPrefix } from '../../primitives/resolve-oid-prefix.js';
import { type RefCandidateOutcome, readRefCandidate } from '../../primitives/resolve-ref.js';
import { expandRef, resolveRefLadder, warnIfRefNamesObjectId } from './refname-ambiguity.js';

/**
 * One candidate as `expand_ref` reads it. Never peels: git's plain `get_oid`
 * hands back an annotated tag's own id, and only a commit-ish argument asks
 * for more. A dangling or broken candidate is skipped, not a failure.
 */
const resolveCandidate =
  (ctx: Context) =>
  (candidate: RefName | 'HEAD'): Promise<RefCandidateOutcome> =>
    readRefCandidate(ctx, candidate);

/**
 * `name` as an object id: a full-width oid wins over a same-named ref (git
 * resolves an object name first), then the ref ladder, then an abbreviated
 * oid — which still throws `AMBIGUOUS_OID_PREFIX` when the prefix matches
 * more than one object `accepts` cannot tell apart. `undefined` when nothing matches.
 */
export const resolveRevisionName = async (
  ctx: Context,
  name: string,
  accepts?: CandidateFilter,
): Promise<ObjectId | undefined> => {
  if (isOid(name, ctx.hashConfig)) {
    await warnIfRefNamesObjectId(ctx, name, resolveCandidate(ctx));
    return ObjectIdFactory.from(name);
  }
  const byRef = await resolveRefLadder(ctx, name, resolveCandidate(ctx));
  if (byRef !== undefined) return byRef;
  return resolveOidPrefix(ctx, name, accepts);
};

/**
 * Every object id `name`'s candidate namespaces resolve to, in ladder order —
 * git's `dwim_ref` count. Only `branch`'s start point consults the count, and
 * it refuses more than one.
 */
export const resolvingCandidates = async (
  ctx: Context,
  name: string,
): Promise<ReadonlyArray<ObjectId>> =>
  (await expandRef(ctx, name, resolveCandidate(ctx))).map((found) => found.id);

/** Every real ref `name`'s candidate namespaces resolve to, in ladder order — the
 *  `dwim_ref` count whose single answer `set_merge` keeps. */
export const resolvingCandidateRefs = async (
  ctx: Context,
  name: string,
): Promise<ReadonlyArray<RefName>> =>
  (await expandRef(ctx, name, resolveCandidate(ctx))).map((found) => found.ref);

/** git's `dwim_ref` real ref as a command's own `dwim_ref` call reads it, warning on each skipped namespace. */
export const dwimRefNameWarning = async (
  ctx: Context,
  name: string,
): Promise<RefName | undefined> => (await expandRef(ctx, name, resolveCandidate(ctx)))[0]?.ref;

/** git's `dwim_ref` real ref: the first candidate namespace `name` resolves in,
 *  symbolic refs followed to the ref they end at. A dangling or broken
 *  candidate is skipped; this read is quiet, the counting one warns. */
export const dwimRefName = async (ctx: Context, name: string): Promise<RefName | undefined> => {
  for (const candidate of refCandidates(name)) {
    const outcome = await readRefCandidate(ctx, candidate);
    if (outcome.kind === 'found') return outcome.ref;
  }
  return undefined;
};
