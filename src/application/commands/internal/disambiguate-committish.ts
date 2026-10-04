/**
 * git's `disambiguate_committish_only` and `disambiguate_treeish_only`: a
 * candidate for an abbreviated name is commit-ish when it is a commit, or a
 * tag whose chain ends at one; tree-ish when it, or the end of its tag chain,
 * is a tree or a commit. A tag naming an absent object, or one git cannot
 * parse, ends nowhere.
 */
import { errorDataCode } from '../../../domain/error-data-code.js';
import type { GitObject, ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readObject } from '../../primitives/read-object.js';
import type { CandidateFilter } from '../../primitives/resolve-oid-prefix.js';

/** `parse_object` answering nothing: an absent object, or a tag `parse_tag_buffer` refuses. */
const ENDS_NOWHERE: ReadonlySet<string | undefined> = new Set(['OBJECT_NOT_FOUND', 'INVALID_TAG']);

const readPresent = async (ctx: Context, id: ObjectId): Promise<GitObject | undefined> => {
  try {
    return await readObject(ctx, id);
  } catch (error) {
    if (ENDS_NOWHERE.has(errorDataCode(error))) return undefined;
    throw error;
  }
};

const TREEISH_TYPES: ReadonlySet<string | undefined> = new Set(['tree', 'commit']);

const chainEnd = async (ctx: Context, id: ObjectId): Promise<GitObject | undefined> => {
  let current = await readPresent(ctx, id);
  while (current?.type === 'tag') current = await readPresent(ctx, current.data.object);
  return current;
};

export const committishFilter =
  (ctx: Context): CandidateFilter =>
  async (id) =>
    (await chainEnd(ctx, id))?.type === 'commit';

export const treeishFilter =
  (ctx: Context): CandidateFilter =>
  async (id) =>
    TREEISH_TYPES.has((await chainEnd(ctx, id))?.type);
