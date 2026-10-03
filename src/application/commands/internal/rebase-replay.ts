import { sortInTopologicalOrder } from '../../../domain/commit/topological-sort.js';
import type { Commit, ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { resolveLimitOptions, walkLimited } from '../../primitives/internal/limit-list.js';
import { mergeBase } from '../../primitives/merge-base.js';
import { computePatchId } from '../../primitives/patch-id.js';

export interface RebaseReplayInput {
  readonly upstream: ObjectId;
  readonly head: ObjectId;
}

/**
 * git's `sequencer_make_script` walk (`<upstream>...<head>`, `--right-only
 * --cherry-mark --no-merges --topo-order --reverse`): both sides walked
 * together down to their merge bases (`limit_list`), sorted in graph order
 * across both, then the head side's non-merge commits whose patch the
 * upstream side does not already carry — oldest first.
 */
export const resolveRebaseReplay = async (
  ctx: Context,
  input: RebaseReplayInput,
): Promise<ReadonlyArray<ObjectId>> => {
  const walked = sortInTopologicalOrder(await walkBothSides(ctx, input), 'graph');
  const upstreamSide = reachableWithin(walked, input.upstream);
  const upstreamPatches = await patchIdsOf(
    ctx,
    walked.filter((commit) => upstreamSide.has(commit.id) && !isMerge(commit)),
  );
  const headSide = walked.filter((commit) => !upstreamSide.has(commit.id) && !isMerge(commit));
  const replayed: ObjectId[] = [];
  for (const commit of headSide) {
    if (!upstreamPatches.has(await computePatchId(ctx, commit.id))) replayed.push(commit.id);
  }
  return replayed.reverse();
};

const walkBothSides = async (
  ctx: Context,
  input: RebaseReplayInput,
): Promise<ReadonlyArray<Commit>> => {
  const bases = await mergeBase(ctx, [input.upstream, input.head], { all: true });
  const options = await resolveLimitOptions(
    ctx,
    { from: [input.upstream, input.head] },
    { until: new Set(bases), firstParent: false, settle: 'slop' },
  );
  const commits: Commit[] = [];
  for await (const commit of walkLimited(ctx, options)) commits.push(commit);
  return commits;
};

/** git's `SYMMETRIC_LEFT` side: the walked commits `tip` reaches through walked parents. */
const reachableWithin = (walked: ReadonlyArray<Commit>, tip: ObjectId): ReadonlySet<ObjectId> => {
  const byId = new Map(walked.map((commit) => [commit.id, commit]));
  const reached = new Set<ObjectId>();
  const pending = byId.has(tip) ? [tip] : [];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (reached.has(id)) continue;
    reached.add(id);
    pending.push(...(byId.get(id)?.data.parents.filter((parent) => byId.has(parent)) ?? []));
  }
  return reached;
};

/** git computes no patch-id for a merge (`patch_id_defined`). */
const isMerge = (commit: Commit): boolean => commit.data.parents.length > 1;

const patchIdsOf = async (
  ctx: Context,
  commits: ReadonlyArray<Commit>,
): Promise<ReadonlySet<string>> => {
  const ids = new Set<string>();
  for (const commit of commits) ids.add(await computePatchId(ctx, commit.id));
  return ids;
};
