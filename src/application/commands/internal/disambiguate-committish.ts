/**
 * git's `disambiguate_committish_only`: a candidate for an abbreviated name is
 * commit-ish when it is a commit, or a tag whose chain ends at one. A tag
 * naming an absent object ends nowhere, so it is not commit-ish.
 */
import { errorDataCode } from '../../../domain/error-data-code.js';
import type { GitObject, ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readObject } from '../../primitives/read-object.js';
import type { CandidateFilter } from '../../primitives/resolve-oid-prefix.js';

const readPresent = async (ctx: Context, id: ObjectId): Promise<GitObject | undefined> => {
  try {
    return await readObject(ctx, id);
  } catch (error) {
    if (errorDataCode(error) === 'OBJECT_NOT_FOUND') return undefined;
    throw error;
  }
};

export const committishFilter =
  (ctx: Context): CandidateFilter =>
  async (id) => {
    let current = await readPresent(ctx, id);
    while (current?.type === 'tag') current = await readPresent(ctx, current.data.object);
    return current?.type === 'commit';
  };
