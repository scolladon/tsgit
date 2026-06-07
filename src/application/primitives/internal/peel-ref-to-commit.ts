/**
 * Peel a ref target through its annotated-tag chain to the commit it names,
 * bounded by `MAX_PEEL_DEPTH`. Shared by `describe` and `name-rev`, which both
 * build a commit→ref map and need the outermost tagger date for tie-breaking.
 * Returns `undefined` when the chain is too deep or terminates at a non-commit.
 */
import type { Commit, ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readObject } from '../read-object.js';
import { exceedsMaxPeelDepth } from '../validators.js';

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
  for (let depth = 0; current.type === 'tag'; depth += 1) {
    if (exceedsMaxPeelDepth(depth)) return undefined;
    if (!viaTag) taggerDate = current.data.tagger?.timestamp ?? 0;
    viaTag = true;
    current = await readObject(ctx, current.data.object);
  }
  if (current.type !== 'commit') return undefined;
  return { commit: current, viaTag, taggerDate };
};
