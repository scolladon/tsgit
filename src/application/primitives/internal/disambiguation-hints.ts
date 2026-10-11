/**
 * git's disambiguation hints: which candidates for an abbreviated name are
 * the kind a caller reads. `disambiguate_commit_only`, `_tree_only` and
 * `_blob_only` judge the object's own type; `disambiguate_committish_only`
 * and `_treeish_only` also accept a tag whose chain ends at a commit (or, for
 * tree-ish, a tree). A tag naming an absent object, or one git cannot parse,
 * ends nowhere. `core.disambiguate` picks the hint a caller naming none gets.
 */

import { errorDataCode } from '../../../domain/error-data-code.js';
import type { DisambiguationHint } from '../../../domain/objects/disambiguation-hint.js';
import { parseDisambiguationHint } from '../../../domain/objects/disambiguation-hint.js';
import type { GitObject, ObjectId, ObjectType } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { findLastEntry } from '../config-read.js';
import { readDeclaredObjectHeader, readObject } from '../read-object.js';
import type { CandidateFilter } from './ambiguous-candidates.js';

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

const ownTypeFilter =
  (type: ObjectType) =>
  (ctx: Context): CandidateFilter =>
  async (id) =>
    (await readDeclaredObjectHeader(ctx, id)).type === type;

export const commitFilter = ownTypeFilter('commit');
export const treeFilter = ownTypeFilter('tree');
export const blobFilter = ownTypeFilter('blob');

const HINT_FILTERS: Readonly<
  Record<DisambiguationHint, ((ctx: Context) => CandidateFilter) | undefined>
> = {
  none: undefined,
  commit: commitFilter,
  committish: committishFilter,
  tree: treeFilter,
  treeish: treeishFilter,
  blob: blobFilter,
};

/**
 * `default_disambiguate_hint`: the filter `core.disambiguate` names, or none.
 * The repository gate has already refused a valueless or unknown value.
 */
export const configuredHint = async (ctx: Context): Promise<CandidateFilter | undefined> => {
  const entry = await findLastEntry(ctx, 'core', 'disambiguate');
  // Stryker disable next-line StringLiteral: equivalent — '' parses to no hint and 'none' maps to no filter, so both give undefined
  const hint = parseDisambiguationHint(entry?.value ?? 'none');
  return hint === undefined ? undefined : HINT_FILTERS[hint]?.(ctx);
};
