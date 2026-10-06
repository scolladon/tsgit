/**
 * git's `get_fork_point` (`merge-base --fork-point <ref> <commit>`): the commit
 * `commit` forked from, judged against every value `ref` has held according to
 * its reflog — so a rewritten upstream still names the commit the local branch
 * was built on.
 */
import type { ObjectId, RefName } from '../../../domain/objects/index.js';
import { isSafeRefName } from '../../../domain/refs/ref-validation.js';
import type { Context } from '../../../ports/context.js';
import { hasObject } from '../../primitives/has-object.js';
import { mergeBasesOf } from '../../primitives/merge-base.js';
import { readObject } from '../../primitives/read-object.js';
import { readReflogLenient } from '../../primitives/reflog-store.js';
import { resolveRefOrMissing } from '../../primitives/resolve-ref.js';

const isCommit = async (ctx: Context, id: ObjectId): Promise<boolean> =>
  (await hasObject(ctx, id)) && (await readObject(ctx, id)).type === 'commit';

/** git's `collect_one_reflog_ent`: the first entry's old value, then every new value, commits only. */
const reflogCommits = async (ctx: Context, ref: RefName): Promise<ReadonlyArray<ObjectId>> => {
  const entries = await readReflogLenient(ctx, ref);
  const ids = [...entries.slice(0, 1).map((entry) => entry.oldId), ...entries.map((e) => e.newId)];
  const commits = new Set<ObjectId>();
  for (const id of ids) if (await isCommit(ctx, id)) commits.add(id);
  return [...commits];
};

/** `undefined` when `ref` is no ref, or when no single reflog value is the merge base. */
export const forkPoint = async (
  ctx: Context,
  ref: RefName,
  commit: ObjectId,
): Promise<ObjectId | undefined> => {
  if (!isSafeRefName(ref)) return undefined;
  const tip = await resolveRefOrMissing(ctx, ref);
  if (tip === undefined) return undefined;
  const logged = await reflogCommits(ctx, ref);
  const candidates = logged.length > 0 ? logged : [tip];
  const bases = await mergeBasesOf(ctx, [commit, ...candidates], { all: true });
  const [base] = bases;
  if (bases.length !== 1 || !candidates.includes(base!)) return undefined;
  return base;
};
