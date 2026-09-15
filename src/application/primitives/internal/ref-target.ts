/**
 * The check `updateRef` and the direct remote-sourced writers run before
 * committing a new value: git's `ref_transaction_update` verification
 * (`refs.c:1425-1445`). The object must exist with intact bytes, and a
 * branch update additionally needs a commit.
 */
import { unexpectedObjectType } from '../../../domain/objects/error.js';
import { type ObjectId, type RefName, zeroOid } from '../../../domain/objects/index.js';
import { HEADS_PREFIX } from '../../../domain/refs/ref-prefixes.js';
import type { Context } from '../../../ports/context.js';
import { verifyStoredObject } from './blob-source.js';

const HEAD_REF: RefName = 'HEAD' as RefName;

/** git's `is_branch` (`refs.c:1072`): only `HEAD` and `refs/heads/*` are
 *  typed to a commit. */
const isBranchRef = (name: RefName): boolean => name === HEAD_REF || name.startsWith(HEADS_PREFIX);

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
  const { type } = await verifyStoredObject(ctx, id);
  if (type !== 'commit' && isBranchRef(name)) throw unexpectedObjectType('commit', type, id);
};
