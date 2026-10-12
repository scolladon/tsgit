/**
 * git's `handle_dotdot` for `A...B`: each side looked up as a commit through
 * its tags, then the merge bases the range excludes. Both sides are looked up
 * before git refuses either that peels to no commit; a walk that fails to
 * parse a parent leaves no range, so the caller reads the argument whole.
 */
import {
  invalidSymmetricRange,
  type SymmetricRangeNonCommit,
} from '../../../domain/commands/error.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { peelChain, tagHop } from '../../primitives/internal/peel-chain.js';
import { tryMergeBasesOf } from '../../primitives/merge-base.js';
import { readObject } from '../../primitives/read-object.js';

type SymmetricSide =
  | { readonly kind: 'commit'; readonly commit: ObjectId }
  | { readonly kind: 'non-commit'; readonly side: SymmetricRangeNonCommit };

/** git's `lookup_commit_reference` on one side of `A...B`: the side as named, peeled through its tags. */
const peelSymmetricSide = async (ctx: Context, id: ObjectId): Promise<SymmetricSide> => {
  const { id: peeled, result } = await peelChain(ctx, id, readObject, tagHop);
  if (result.type === 'commit') return { kind: 'commit', commit: peeled };
  return { kind: 'non-commit', side: { id, type: result.type } };
};

/**
 * The merge bases `A...B` excludes; both sides are looked up before git
 * refuses either. `undefined` when the walk logs a parent it cannot parse.
 */
export const symmetricBases = async (
  ctx: Context,
  expression: string,
  sides: readonly [ObjectId, ObjectId],
): Promise<ReadonlyArray<ObjectId> | undefined> => {
  const peeled = [await peelSymmetricSide(ctx, sides[0]), await peelSymmetricSide(ctx, sides[1])];
  const commits = peeled.flatMap((side) => (side.kind === 'commit' ? [side.commit] : []));
  const nonCommits = peeled.flatMap((side) => (side.kind === 'non-commit' ? [side.side] : []));
  if (nonCommits.length > 0) throw invalidSymmetricRange(expression, nonCommits);
  return tryMergeBasesOf(ctx, commits, { all: true });
};
