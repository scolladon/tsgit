/**
 * The `--rebase-merges` todo for `<upstream>...<head>`: git's walk (merges kept),
 * each commit's skip verdict, and the branch names, abbreviations and subjects
 * the pure {@link makeScriptWithMerges} labels with.
 */
import { subjectLine } from '../../../domain/objects/commit-message.js';
import { type ObjectId, RefName } from '../../../domain/objects/index.js';
import {
  makeScriptWithMerges,
  type RebaseTodoLine,
  type ScriptCommit,
} from '../../../domain/rebase/index.js';
import type { Context } from '../../../ports/context.js';
import { abbreviateObjectId } from '../../primitives/abbreviate-object-id.js';
import { getRefStore } from '../../primitives/ref-store.js';
import { readCommitData } from './history-rewrite.js';
import { walkRebaseRange } from './rebase-replay.js';

const HEADS_PREFIX = 'refs/heads/';

export interface RebaseMergesTodoInput {
  readonly upstream: ObjectId;
  readonly head: ObjectId;
  readonly rebaseCousins: boolean;
}

/** `refs/heads/` decorations by commit; the last name in ref order wins, as git's list does. */
const branchNamesOf = async (ctx: Context): Promise<ReadonlyMap<ObjectId, string>> => {
  const names = new Map<ObjectId, string>();
  for (const ref of await getRefStore(ctx).listRefs(RefName.from(HEADS_PREFIX))) {
    if (ref.value.kind === 'direct') names.set(ref.value.id, ref.name.slice(HEADS_PREFIX.length));
  }
  return names;
};

/** Parents outside the range, and merged tips a label may fall back to abbreviating. */
const labelFallbacks = (commits: ReadonlyArray<ScriptCommit>): ReadonlyArray<ObjectId> => {
  const inRange = new Set(commits.map((c) => c.id));
  // Stryker disable next-line MethodExpression: equivalent — an in-range first parent is never abbreviated (labelOid abbreviates only out-of-range parents and merged tips), so the extra entries are never read.
  const outside = commits.flatMap((c) => c.parents).filter((p) => !inRange.has(p));
  // Stryker disable next-line MethodExpression: equivalent — an in-range first parent is never abbreviated (labelOid abbreviates only out-of-range parents and merged tips), so the extra entries are never read.
  return [...new Set([...outside, ...commits.flatMap((c) => c.parents.slice(1))])];
};

const describeFallbacks = async (ctx: Context, oids: ReadonlyArray<ObjectId>) => {
  const abbreviations = new Map<ObjectId, string>();
  const outsideSubjects = new Map<ObjectId, string>();
  for (const oid of oids) {
    abbreviations.set(oid, await abbreviateObjectId(ctx, oid));
    outsideSubjects.set(oid, subjectLine((await readCommitData(ctx, oid)).message));
  }
  return { abbreviations, outsideSubjects };
};

export const rebaseMergesTodo = async (
  ctx: Context,
  input: RebaseMergesTodoInput,
): Promise<ReadonlyArray<RebaseTodoLine>> => {
  const range = await walkRebaseRange(ctx, input);
  const commits: ScriptCommit[] = [];
  for (const commit of range.headSide) {
    const skipped = await range.isUpstream(commit);
    const subject = subjectLine(commit.data.message);
    commits.push({ id: commit.id, parents: commit.data.parents, subject, skipped });
  }
  return makeScriptWithMerges({
    commits,
    ontoBase: range.bases[0],
    branchNames: await branchNamesOf(ctx),
    ...(await describeFallbacks(ctx, labelFallbacks(commits))),
    rebaseCousins: input.rebaseCousins,
  });
};
