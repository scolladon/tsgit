/**
 * git rebase's reads of its `<upstream>` and `--onto <newbase>`: each a whole
 * revision peeled to its commit (`lookup_commit_reference_by_name`), an onto
 * holding `...` the sole merge base of its sides (`repo_get_oid_mb`).
 */
import { rebaseRevisionInvalid } from '../../../domain/commands/error.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { lookupTypedCommitReference } from '../../primitives/internal/lookup-commit-reference.js';
import {
  createObjectTypeTable,
  type ObjectTypeTable,
} from '../../primitives/internal/object-type-table.js';
import { mergeBasesOf } from '../../primitives/merge-base.js';
import { readCommittish } from '../rev-parse.js';
import { branchBaseOf } from './rebase-fast-forward.js';

const SYMMETRIC = '...';
/** git's `repo_get_oid_mb` reads a side of `A...B` left out as `HEAD`. */
const orHead = (side: string): string => (side === '' ? 'HEAD' : side);

export interface RebaseSidesInput {
  readonly upstreamName: string;
  readonly ontoName: string;
  readonly head: ObjectId;
}

export interface RebaseSides {
  readonly upstream: ObjectId;
  readonly onto: ObjectId;
  /** The sole merge base of onto and head (git's `fill_branch_base`), or an `A...B` onto itself. */
  readonly branchBase: ObjectId | undefined;
}

export const resolveRebaseSides = async (
  ctx: Context,
  { upstreamName, ontoName, head }: RebaseSidesInput,
): Promise<RebaseSides> => {
  const table = createObjectTypeTable();
  const upstream = await commitByName(ctx, table, upstreamName);
  if (upstream === undefined) {
    throw rebaseRevisionInvalid({ reason: 'invalid-upstream', revision: upstreamName });
  }
  if (ontoName.includes(SYMMETRIC)) {
    const onto = await soleMergeBase(ctx, table, ontoName);
    return { upstream, onto, branchBase: onto };
  }
  const onto = await commitByName(ctx, table, ontoName);
  if (onto === undefined)
    throw rebaseRevisionInvalid({ reason: 'invalid-onto', revision: ontoName });
  return { upstream, onto, branchBase: await branchBaseOf(ctx, onto, head) };
};

/** git's `lookup_commit_reference_by_name`: the commit `name` peels to, `undefined` when it names none. */
const commitByName = async (
  ctx: Context,
  table: ObjectTypeTable,
  name: string,
): Promise<ObjectId | undefined> => {
  const id = await readCommittish(ctx, table, name);
  return id === undefined ? undefined : lookupTypedCommitReference(ctx, table, id);
};

/** git's `repo_get_oid_mb` over an `A...B` onto: refused unless its sides share exactly one merge base. */
const soleMergeBase = async (
  ctx: Context,
  table: ObjectTypeTable,
  name: string,
): Promise<ObjectId> => {
  const bases = await sideMergeBases(ctx, table, name);
  if (bases.length !== 1) {
    throw rebaseRevisionInvalid({ reason: 'onto-merge-base-not-unique', revision: name });
  }
  return bases[0] as ObjectId;
};

const sideMergeBases = async (
  ctx: Context,
  table: ObjectTypeTable,
  name: string,
): Promise<readonly ObjectId[]> => {
  const dots = name.indexOf(SYMMETRIC);
  const one = await commitByName(ctx, table, orHead(name.slice(0, dots)));
  if (one === undefined) return [];
  const two = await commitByName(ctx, table, orHead(name.slice(dots + SYMMETRIC.length)));
  if (two === undefined) return [];
  return mergeBasesOf(ctx, [one, two], { all: true }, table);
};
