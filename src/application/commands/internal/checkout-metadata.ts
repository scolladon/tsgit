import type { ObjectId } from '../../../domain/objects/object-id.js';
import type { Context } from '../../../ports/context.js';
import type { CheckoutMetadata } from '../../primitives/internal/apply-smudge-filter.js';
import { dwimRefName } from './revision-name.js';

const REFS_PREFIX = 'refs/';

/**
 * git's `init_checkout_metadata` for a move to `commit` named by `rev`: the
 * commit, plus the ref `rev` resolves to (git's `dwim_ref`) when it names one under `refs/`.
 */
export const checkoutMetadataFor = async (
  ctx: Context,
  rev: string,
  commit: ObjectId,
): Promise<CheckoutMetadata> => {
  const ref = await dwimRefName(ctx, rev);
  return ref?.startsWith(REFS_PREFIX) === true ? { ref, treeish: commit } : { treeish: commit };
};
