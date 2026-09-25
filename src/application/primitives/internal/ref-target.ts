/**
 * The check `updateRef` and the direct remote-sourced writers run before
 * committing a new value: git's `ref_transaction_update` verification
 * (`refs.c:1425-1445`). The object must exist with intact bytes, a commit or
 * tag target must pass git's own parse acceptance, and a branch update
 * additionally needs a commit.
 */
import { invalidCommit, invalidTag, unexpectedObjectType } from '../../../domain/objects/error.js';
import type { ObjectId, ObjectType, RefName } from '../../../domain/objects/index.js';
import {
  needsParentLookups,
  type ParseAcceptanceScan,
  parseAcceptanceVerdict,
} from '../../../domain/objects/parse-acceptance.js';
import { HEADS_PREFIX } from '../../../domain/refs/ref-prefixes.js';
import type { Context } from '../../../ports/context.js';
import { hasObject } from '../has-object.js';
import { verifyStoredObject } from './blob-source.js';
import { loadShallowSet } from './shallow-set.js';

const HEAD_REF: RefName = 'HEAD' as RefName;

/** At most this many verified ids are remembered per Context, oldest
 *  forgotten first — a long-lived Context writing ever more distinct targets
 *  keeps a bounded memo. */
const VERIFIED_TARGETS_CAP = 4096;

/**
 * Ids a Context already verified — present, hashing to their id, and
 * parse-accepted without consulting the shallow set — with the type found.
 * Content addressing keeps those bytes and that verdict valid for as long as
 * the object is present, so a remembered id re-probes presence only (git's
 * `parse_object` likewise returns an already-parsed object without hashing it again). An
 * acceptance that depended on `.git/shallow` is never remembered: the
 * shallow set can change under the same Context.
 */
const verifiedTargets = new WeakMap<Context, Map<ObjectId, ObjectType>>();

/** git's `is_branch` (`refs.c:1072`): only `HEAD` and `refs/heads/*` are
 *  typed to a commit. */
const isBranchRef = (name: RefName): boolean => name === HEAD_REF || name.startsWith(HEADS_PREFIX);

/** git's parse_commit_buffer / parse_tag_buffer acceptance, read only after
 *  the hash has already passed. The shallow-set lookup is a per-commit
 *  decision (skipped only for a recorded shallow boundary), so it is read
 *  at most once, and only when a parent id equalled the tree id. */
const assertParseAccepted = async (
  ctx: Context,
  id: ObjectId,
  scan: ParseAcceptanceScan,
): Promise<void> => {
  const shallow = needsParentLookups(scan) && (await loadShallowSet(ctx)).has(id);
  const refusal = parseAcceptanceVerdict(scan, { parentLookups: shallow ? 'skipped' : 'checked' });
  if (refusal === undefined) return;
  throw refusal.type === 'commit' ? invalidCommit(refusal.reason) : invalidTag(refusal.reason);
};

const verifiedTargetsOf = (ctx: Context): Map<ObjectId, ObjectType> => {
  const existing = verifiedTargets.get(ctx);
  if (existing !== undefined) return existing;
  const created = new Map<ObjectId, ObjectType>();
  verifiedTargets.set(ctx, created);
  return created;
};

const rememberVerified = (
  memo: Map<ObjectId, ObjectType>,
  id: ObjectId,
  type: ObjectType,
): void => {
  // A full memo is never empty, so its first key — the oldest — exists.
  if (memo.size >= VERIFIED_TARGETS_CAP) memo.delete(memo.keys().next().value as ObjectId);
  memo.set(id, type);
};

/** `id`'s type once it is verified present, intact and parse-accepted —
 *  from the memo when this Context already verified it and it is still
 *  present, from a full verification otherwise. */
const verifiedTargetType = async (ctx: Context, id: ObjectId): Promise<ObjectType> => {
  const memo = verifiedTargetsOf(ctx);
  const known = memo.get(id);
  // Quick probe only: a miss here falls straight through to
  // `verifyStoredObject` below, whose own content read already re-scans once
  // on a full miss (`retryOnceAfterRescan`) — the SAME one retry
  // `hasObject`'s own `'recheck'` mode would pay here, so gating on
  // `'recheck'` would cost a SECOND re-scan wave on a genuine miss for no
  // different verdict. This still runs for every ref write, including the
  // fetch/clone-driven ones that land right after a pack just landed on
  // disk — git's `update_local_ref` calls `odb_has_object` with
  // `HAS_OBJECT_RECHECK_PACKED`, and one re-scan (paid below, not here) is
  // exactly that.
  if (known !== undefined && (await hasObject(ctx, id))) return known;
  const { type, acceptance } = await verifyStoredObject(ctx, id);
  if (acceptance !== undefined) await assertParseAccepted(ctx, id, acceptance);
  if (acceptance === undefined || !needsParentLookups(acceptance)) rememberVerified(memo, id, type);
  return type;
};

/**
 * Verifies a ref update's target the way git's ref transaction does, against
 * the GIVEN name — never the write chain's terminal (a tree reached through
 * a symref is typed by the name the caller passed, not what it resolves
 * to). Every write is checked before the compare-and-swap; the null id is
 * no exception — it names no stored object, so it refuses as missing.
 */
export const assertRefTargetValid = async (
  ctx: Context,
  name: RefName,
  id: ObjectId,
): Promise<void> => {
  const type = await verifiedTargetType(ctx, id);
  if (type !== 'commit' && isBranchRef(name)) throw unexpectedObjectType('commit', type, id);
};
