/**
 * The check `updateRef` and the direct remote-sourced writers run before
 * committing a new value: git's `ref_transaction_update` verification
 * (`refs.c:1425-1445`). The object must exist with intact bytes, a commit or
 * tag target must pass git's own parse acceptance, and a branch update
 * additionally needs a commit.
 */
import { invalidCommit, invalidTag, unexpectedObjectType } from '../../../domain/objects/error.js';
import { type ObjectId, type RefName, zeroOid } from '../../../domain/objects/index.js';
import {
  needsParentLookups,
  type ParseAcceptanceScan,
  parseAcceptanceVerdict,
} from '../../../domain/objects/parse-acceptance.js';
import { HEADS_PREFIX } from '../../../domain/refs/ref-prefixes.js';
import type { Context } from '../../../ports/context.js';
import { verifyStoredObject } from './blob-source.js';
import { loadShallowSet } from './shallow-set.js';

const HEAD_REF: RefName = 'HEAD' as RefName;

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

/**
 * Verifies a ref update's target the way git's ref transaction does, against
 * the GIVEN name — never the write chain's terminal (a tree reached through
 * a symref is typed by the name the caller passed, not what it resolves
 * to). The null id is git's delete sentinel and is never verified; every
 * other write is checked before the compare-and-swap.
 */
export const assertRefTargetValid = async (
  ctx: Context,
  name: RefName,
  id: ObjectId,
): Promise<void> => {
  if (id === zeroOid(ctx.hashConfig)) return;
  const { type, acceptance } = await verifyStoredObject(ctx, id);
  if (acceptance !== undefined) await assertParseAccepted(ctx, id, acceptance);
  if (type !== 'commit' && isBranchRef(name)) throw unexpectedObjectType('commit', type, id);
};
