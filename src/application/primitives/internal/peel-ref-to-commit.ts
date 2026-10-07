/**
 * Peel a ref target through its annotated-tag chain, to any depth as git does,
 * to the commit it names, noting whether a tag was crossed and the outermost
 * tagger date — what a caller ranking refs by tag needs to break ties.
 * Returns `undefined` when the chain loops (a store whose objects do not hash
 * to their names) or terminates at a non-commit.
 */
import type { Commit, ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readObject } from '../read-object.js';

export interface PeeledRef {
  readonly commit: Commit;
  /** The ref pointed at a tag object (an annotated tag), not straight at the commit. */
  readonly viaTag: boolean;
  /** Outermost annotated-tag tagger timestamp; `0` when not reached via a tag. */
  readonly taggerDate: number;
}

export const peelRefToCommit = async (
  ctx: Context,
  oid: ObjectId,
): Promise<PeeledRef | undefined> => {
  let current = await readObject(ctx, oid);
  let viaTag = false;
  let taggerDate = 0;
  const seen = new Set<ObjectId>([oid]);
  while (current.type === 'tag') {
    const next = current.data.object;
    if (seen.has(next)) return undefined;
    seen.add(next);
    if (!viaTag) taggerDate = current.data.tagger?.timestamp ?? 0;
    viaTag = true;
    current = await readObject(ctx, next);
  }
  if (current.type !== 'commit') return undefined;
  return { commit: current, viaTag, taggerDate };
};
