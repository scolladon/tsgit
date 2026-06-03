/**
 * Tier-1 `describe` command — name a commit by its nearest reachable tag,
 * faithful to `git describe` (ADR-249). Returns structured data only: the chosen
 * ref, its describe short-name, the commit distance, the target oid, and the
 * exact/dirty flags. The library renders no line and abbreviates no oid —
 * assembling `<name>-<distance>-g<abbrev>` is the caller's responsibility.
 */
import {
  noAnnotatedNames,
  noExactMatch,
  noNames,
  noReachableNames,
} from '../../domain/commands/error.js';
import {
  buildNameFilter,
  type Candidate,
  compareCandidates,
  type DescribeName,
  describeName,
  shouldReplaceName,
} from '../../domain/describe/index.js';
import type { GitObject, ObjectId, RefName } from '../../domain/objects/index.js';
import { RefName as RefNameFactory } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { enumerateRefs } from '../primitives/enumerate-refs.js';
import { readObject } from '../primitives/read-object.js';
import { getRefStore } from '../primitives/ref-store.js';
import { exceedsMaxPeelDepth } from '../primitives/validators.js';
import { resolveCommitIsh } from './internal/commit-ish.js';
import { parseDescribeOptions, type ResolvedDescribePlan } from './internal/describe-options.js';
import { assertRepository } from './internal/repo-state.js';
import { status } from './status.js';

export interface DescribeOptions {
  /** Include lightweight tags (priority ≥ 1), not just annotated ones. */
  readonly tags?: boolean;
  /** Consider every ref (branches, remotes; priority 0), not only tags. */
  readonly all?: boolean;
  /** Always emit a result even when no tag matches, falling back to the oid. */
  readonly always?: boolean;
  /** Only an exact tag on the target counts (≡ `candidates: 0`). */
  readonly exactMatch?: boolean;
  /** Maximum tags considered during the search. Default 10. */
  readonly candidates?: number;
  /** Follow only first parents through merges. */
  readonly firstParent?: boolean;
  /** Short-name globs a tag must match to be considered. */
  readonly match?: string | ReadonlyArray<string>;
  /** Short-name globs that drop a tag from consideration. */
  readonly exclude?: string | ReadonlyArray<string>;
  /** Report whether HEAD's working tree has tracked changes (HEAD only). */
  readonly dirty?: boolean;
  /** Tolerate a working tree whose state can't be read, reporting it dirty. */
  readonly broken?: boolean;
}

export interface DescribeResult {
  /** Chosen ref (a tag, or any ref under `all`); `undefined` on the `always` fallback. */
  readonly tag: RefName | undefined;
  /** Describe short-name (`v2.0`, `heads/main`); `''` on the `always` fallback. */
  readonly name: string;
  /** Commits between the chosen ref and the target (`0` when exact). */
  readonly distance: number;
  /** Full 40-hex oid of the described commit; the caller abbreviates it. */
  readonly oid: ObjectId;
  /** `true` when the target itself carries the chosen tag. */
  readonly exact: boolean;
  /** `true` when HEAD's working tree had tracked changes (`dirty`/`broken`). */
  readonly dirty: boolean;
}

const DEFAULT_REV = 'HEAD';
const TAGS_PREFIX = 'refs/tags/';

export const describe = async (
  ctx: Context,
  input?: string,
  opts: DescribeOptions = {},
): Promise<DescribeResult> => {
  await assertRepository(ctx);
  const plan = parseDescribeOptions(opts, input !== undefined);
  const target = await resolveCommitIsh(ctx, input ?? DEFAULT_REV);
  const dirty = await computeDirty(ctx, plan);
  const nameMap = await buildNameMap(ctx, plan);
  const minPriority = minQualifyingPriority(plan);

  const exact = nameMap.get(target);
  if (exact !== undefined && exact.priority >= minPriority) {
    return tagResult(exact.name, 0, target, dirty, plan.all);
  }
  if (plan.maxCandidates === 0) {
    if (plan.always) return alwaysResult(target, dirty);
    throw noExactMatch(target);
  }

  const { best, sawUnannotated } = await selectNearest(ctx, target, nameMap, plan, minPriority);
  if (best !== undefined) {
    return tagResult(best.name, best.depth, target, dirty, plan.all);
  }
  if (plan.always) return alwaysResult(target, dirty);
  if (nameMap.size === 0) throw noNames(target);
  throw sawUnannotated ? noAnnotatedNames(target) : noReachableNames(target);
};

const minQualifyingPriority = (plan: ResolvedDescribePlan): number => {
  if (plan.all) return 0;
  return plan.tags ? 1 : 2;
};

const tagResult = (
  name: string,
  distance: number,
  oid: ObjectId,
  dirty: boolean,
  all: boolean,
): DescribeResult => ({
  tag: RefNameFactory.from(all ? `refs/${name}` : `${TAGS_PREFIX}${name}`),
  name,
  distance,
  oid,
  exact: distance === 0,
  dirty,
});

const alwaysResult = (oid: ObjectId, dirty: boolean): DescribeResult => ({
  tag: undefined,
  name: '',
  distance: 0,
  oid,
  exact: false,
  dirty,
});

const computeDirty = async (ctx: Context, plan: ResolvedDescribePlan): Promise<boolean> => {
  if (!plan.dirty && !plan.broken) return false;
  try {
    const state = await status(ctx);
    return (
      state.indexChanges.length > 0 ||
      state.workingTreeChanges.some((change) => change.kind !== 'untracked')
    );
  } catch (err) {
    if (plan.broken) return true;
    throw err;
  }
};

/** Build the commit→name map from the relevant refs, deduped per commit. */
const buildNameMap = async (
  ctx: Context,
  plan: ResolvedDescribePlan,
): Promise<Map<ObjectId, DescribeName>> => {
  const refs = [...(await enumerateRefs(ctx))]
    .filter((ref) => ref !== 'HEAD' && (plan.all || ref.startsWith(TAGS_PREFIX)))
    .sort();
  const filter = buildNameFilter(plan.include, plan.exclude);
  const store = getRefStore(ctx);
  const map = new Map<ObjectId, DescribeName>();
  for (const ref of refs) {
    const resolved = await store.resolveDirect(ref);
    if (resolved.kind !== 'direct') continue;
    const peeled = await peelToCommit(ctx, resolved.id);
    if (peeled === undefined) continue;
    const shortName = describeName(ref, plan.all);
    if (!filter.matches(shortName)) continue;
    const incoming = nameOf(ref, shortName, peeled);
    const existing = map.get(peeled.commitOid);
    if (existing === undefined || shouldReplaceName(existing, incoming)) {
      map.set(peeled.commitOid, incoming);
    }
  }
  return map;
};

interface PeeledCommit {
  readonly commitOid: ObjectId;
  readonly viaTag: boolean;
  readonly taggerDate: number;
}

const nameOf = (ref: RefName, shortName: string, peeled: PeeledCommit): DescribeName => {
  const underTags = ref.startsWith(TAGS_PREFIX);
  const priority = underTags ? (peeled.viaTag ? 2 : 1) : 0;
  return { name: shortName, priority, taggerDate: peeled.taggerDate };
};

/** Peel a ref target to its commit, capturing the outermost tagger date. */
const peelToCommit = async (ctx: Context, oid: ObjectId): Promise<PeeledCommit | undefined> => {
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
  return { commitOid: current.id, viaTag, taggerDate };
};

/** A commit read reduced to the two fields the walk needs. */
interface WalkCommit {
  readonly date: number;
  readonly parents: ReadonlyArray<ObjectId>;
}

interface QueueEntry {
  readonly oid: ObjectId;
  readonly date: number;
}

/** Mutable state threaded through the date-ordered walk. */
interface WalkState {
  readonly queue: QueueEntry[];
  readonly seen: Set<ObjectId>;
  readonly reach: Map<ObjectId, Set<number>>;
  readonly firstParent: boolean;
  readonly read: (oid: ObjectId) => Promise<WalkCommit>;
}

interface SelectionOutcome {
  readonly best: Candidate | undefined;
  readonly sawUnannotated: boolean;
}

/** Date-ordered walk collecting candidate tags and their exact distances. */
const selectNearest = async (
  ctx: Context,
  target: ObjectId,
  nameMap: ReadonlyMap<ObjectId, DescribeName>,
  plan: ResolvedDescribePlan,
  minPriority: number,
): Promise<SelectionOutcome> => {
  const state: WalkState = {
    queue: [],
    seen: new Set<ObjectId>([target]),
    reach: new Map<ObjectId, Set<number>>(),
    firstParent: plan.firstParent,
    read: makeCommitReader(ctx),
  };
  const candidates: Candidate[] = [];
  let counter = 0;
  let sawUnannotated = false;
  let gaveUp: ObjectId | undefined;
  enqueue(state.queue, { oid: target, date: (await state.read(target)).date });

  while (state.queue.length > 0) {
    const { oid } = state.queue.shift() as QueueEntry;
    counter += 1;
    const named = nameMap.get(oid);
    if (named !== undefined && named.priority >= minPriority) {
      if (candidates.length >= plan.maxCandidates) {
        gaveUp = oid;
        break;
      }
      const index = candidates.length;
      candidates.push({ name: named.name, commitOid: oid, depth: counter - 1, foundOrder: index });
      reachSet(state.reach, oid).add(index);
    } else if (named !== undefined) {
      sawUnannotated = true;
    }
    incrementUnreached(candidates, state.reach.get(oid));
    await enqueueParents(state, oid);
  }

  if (candidates.length === 0) return { best: undefined, sawUnannotated };
  const best = [...candidates].sort(compareCandidates)[0] as Candidate;
  if (gaveUp !== undefined) await finishDepth(state, best, gaveUp);
  return { best, sawUnannotated };
};

const makeCommitReader = (ctx: Context): ((oid: ObjectId) => Promise<WalkCommit>) => {
  const cache = new Map<ObjectId, WalkCommit>();
  return async (oid) => {
    const cached = cache.get(oid);
    if (cached !== undefined) return cached;
    const walk = toWalkCommit(await readObject(ctx, oid));
    cache.set(oid, walk);
    return walk;
  };
};

const toWalkCommit = (object: GitObject): WalkCommit => {
  if (object.type !== 'commit') return { date: 0, parents: [] };
  return { date: object.data.committer.timestamp, parents: object.data.parents };
};

const incrementUnreached = (
  candidates: ReadonlyArray<Candidate>,
  reached: Set<number> | undefined,
): void => {
  for (const candidate of candidates) {
    if (reached === undefined || !reached.has(candidate.foundOrder)) candidate.depth += 1;
  }
};

const enqueueParents = async (state: WalkState, oid: ObjectId): Promise<void> => {
  const commit = await state.read(oid);
  const parents = state.firstParent ? commit.parents.slice(0, 1) : commit.parents;
  const reachedHere = state.reach.get(oid);
  for (const parent of parents) {
    if (!state.seen.has(parent)) {
      state.seen.add(parent);
      enqueue(state.queue, { oid: parent, date: (await state.read(parent)).date });
    }
    if (reachedHere !== undefined) {
      const parentReach = reachSet(state.reach, parent);
      for (const index of reachedHere) parentReach.add(index);
    }
  }
};

/** Continue the walk past the candidate cap to finalise the winner's depth. */
const finishDepth = async (state: WalkState, best: Candidate, gaveUp: ObjectId): Promise<void> => {
  enqueue(state.queue, { oid: gaveUp, date: (await state.read(gaveUp)).date });
  while (state.queue.length > 0) {
    const { oid } = state.queue.shift() as QueueEntry;
    const reached = state.reach.get(oid);
    if (reached === undefined || !reached.has(best.foundOrder)) best.depth += 1;
    await enqueueParents(state, oid);
  }
};

const reachSet = (reach: Map<ObjectId, Set<number>>, oid: ObjectId): Set<number> => {
  let set = reach.get(oid);
  if (set === undefined) {
    set = new Set<number>();
    reach.set(oid, set);
  }
  return set;
};

/** Insert keeping the queue newest-date-first, oid-ascending on ties. */
const enqueue = (queue: QueueEntry[], entry: QueueEntry): void => {
  let i = 0;
  while (i < queue.length && !precedes(entry, queue[i] as QueueEntry)) i += 1;
  queue.splice(i, 0, entry);
};

const precedes = (a: QueueEntry, b: QueueEntry): boolean =>
  a.date > b.date || (a.date === b.date && a.oid < b.oid);
