/**
 * Peel a ref target through its annotated-tag chain, to any depth as git does,
 * to the commit it names, noting whether a tag was crossed and the outermost
 * tagger date — what a caller ranking refs by tag needs to break ties.
 * Returns `undefined` when the chain loops (a store whose objects do not hash
 * to their names) or terminates at a non-commit.
 */
import type { Commit, GitObject, ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readObject } from '../read-object.js';
import { peelTagChain } from './peel-chain.js';

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
  const read = (id: ObjectId): Promise<GitObject> => readObject(ctx, id);
  const start = { id: oid, result: await read(oid) };
  const { object, deref, taggerDate } = await peelTagChain(start, read, 'outermost');
  if (object.type !== 'commit') return undefined;
  return { commit: object, viaTag: deref, taggerDate };
};
