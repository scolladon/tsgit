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
import { resolveOidPrefix } from '../../primitives/resolve-oid-prefix.js';
import { resolveRefOrMissing } from '../../primitives/resolve-ref.js';

/**
 * The first candidate in `names` that resolves, or `undefined`. Never peels:
 * git's plain `get_oid` hands back an annotated tag's own id, and only a
 * commit-ish argument asks for more. A candidate that fails for any OTHER
 * reason — a dangling or broken ref — is skipped just as `expand_ref` skips
 * it, rather than failing the whole resolution.
 */
const firstResolving = async (
  ctx: Context,
  names: ReadonlyArray<RefName | 'HEAD'>,
): Promise<ObjectId | undefined> => {
  for (const candidate of names) {
    try {
      const id = await resolveRefOrMissing(ctx, candidate);
      if (id !== undefined) return id;
    } catch {
      // Not this candidate — fall through to the next namespace.
    }
  }
  return undefined;
};

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
  if (isOid(name, ctx.hashConfig)) return ObjectIdFactory.from(name);
  const byRef = await firstResolving(ctx, refCandidates(name));
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
