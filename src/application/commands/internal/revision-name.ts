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
import { getRefStore } from '../../primitives/ref-store.js';
import { resolveOidPrefix } from '../../primitives/resolve-oid-prefix.js';
import {
  type RefCandidateOutcome,
  readRefCandidate,
  resolveRefOrMissing,
} from '../../primitives/resolve-ref.js';
import { MAX_SYMBOLIC_REF_DEPTH } from '../../primitives/types.js';
import { resolveRefLadder, warnIfRefNamesObjectId } from './refname-ambiguity.js';

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
 * more than one object. `undefined` when nothing matches.
 */
export const resolveRevisionName = async (
  ctx: Context,
  name: string,
): Promise<ObjectId | undefined> => {
  if (isOid(name, ctx.hashConfig)) {
    await warnIfRefNamesObjectId(ctx, name, resolveCandidate(ctx));
    return ObjectIdFactory.from(name);
  }
  const byRef = await resolveRefLadder(ctx, name, resolveCandidate(ctx));
  if (byRef !== undefined) return byRef;
  return resolveOidPrefix(ctx, name);
};

/**
 * Every object id `name`'s candidate namespaces resolve to, in ladder order —
 * git's `dwim_ref` count. Reading them all is what `dwim_ref` does too; only
 * `branch`'s start point consults the count, and it refuses more than one.
 */
export const resolvingCandidates = async (
  ctx: Context,
  name: string,
): Promise<ReadonlyArray<ObjectId>> => {
  const found: ObjectId[] = [];
  for (const candidate of refCandidates(name)) {
    try {
      const id = await resolveRefOrMissing(ctx, candidate);
      if (id !== undefined) found.push(id);
    } catch {
      // A dangling or broken candidate is skipped, as `expand_ref` skips it.
    }
  }
  return found;
};

/** Whether `candidate` resolves; a dangling or broken one does not, as `expand_ref` skips it. */
const resolvesQuietly = async (ctx: Context, candidate: RefName): Promise<boolean> => {
  try {
    return (await resolveRefOrMissing(ctx, candidate)) !== undefined;
  } catch {
    return false;
  }
};

/** The ref a resolving symbolic chain from `name` ends at. */
const terminalRefName = async (ctx: Context, name: RefName): Promise<RefName> => {
  const store = getRefStore(ctx);
  let current = name;
  for (let hop = 0; hop < MAX_SYMBOLIC_REF_DEPTH; hop += 1) {
    const direct = await store.resolveDirect(current);
    if (direct.kind !== 'symbolic') return current;
    current = direct.target;
  }
  return current;
};

/** git's `dwim_ref` real ref: the first candidate namespace `name` resolves in,
 *  symbolic refs followed to the ref they end at. */
export const dwimRefName = async (ctx: Context, name: string): Promise<RefName | undefined> => {
  for (const candidate of refCandidates(name)) {
    if (await resolvesQuietly(ctx, candidate as RefName)) {
      return terminalRefName(ctx, candidate as RefName);
    }
  }
  return undefined;
};
