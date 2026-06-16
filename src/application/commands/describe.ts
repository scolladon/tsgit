/**
 * Tier-1 `describe` command — name a commit by its nearest reachable tag,
 * faithful to `git describe` (ADR-249). Returns structured data only: the chosen
 * ref, its describe short-name, the commit distance, the target oid, and the
 * exact/dirty flags. The library renders no line and abbreviates no oid —
 * assembling `<name>-<distance>-g<abbrev>` is the caller's responsibility.
 */
import {
  cannotDescribe,
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
import type { Commit, ObjectId, RefName } from '../../domain/objects/index.js';
import { RefName as RefNameFactory } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { enumerateRefs } from '../primitives/enumerate-refs.js';
import { commitDateWalk, selectParents } from '../primitives/internal/commit-date-walk.js';
import { type PeeledRef, peelRefToCommit } from '../primitives/internal/peel-ref-to-commit.js';
import { getRefStore } from '../primitives/ref-store.js';
import { resolveCommitIsh } from './internal/commit-ish.js';
import {
  type ContainsPlan,
  parseContainsOptions,
  parseDescribeOptions,
  type ResolvedDescribePlan,
} from './internal/describe-options.js';
import { assertCommandPreamble } from './internal/repo-state.js';
import { type NameRevResult, nameRev } from './name-rev.js';
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
  /** Name the nearest ref that *contains* the commit (delegates to `name-rev`). */
  readonly contains?: boolean;
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

export function describe(
  ctx: Context,
  rev: string | undefined,
  opts: DescribeOptions & { contains: true },
): Promise<NameRevResult>;
export function describe(
  ctx: Context,
  rev?: string,
  opts?: DescribeOptions,
): Promise<DescribeResult>;
export async function describe(
  ctx: Context,
  rev?: string,
  opts: DescribeOptions = {},
): Promise<DescribeResult | NameRevResult> {
  await assertCommandPreamble(ctx);
  if (opts.contains === true) return describeContains(ctx, rev, parseContainsOptions(opts));
  const plan = parseDescribeOptions(opts, rev !== undefined);
  const target = await resolveCommitIsh(ctx, rev ?? DEFAULT_REV);
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
}

// `--contains`: git runs `name-rev --tags --no-undefined` (all refs under `all`,
// `match`/`exclude` mapped to `refs/tags/<pat>`); `always` turns the refusal back
// into an `undefined`-ref result (the caller renders the oid).
const describeContains = async (
  ctx: Context,
  rev: string | undefined,
  plan: ContainsPlan,
): Promise<NameRevResult> => {
  const useTags = !plan.all;
  // Under `all`, git passes no `--refs`/`--exclude` (every ref is a source); under
  // default mode each pattern is scoped to `refs/tags/`.
  const scope = (patterns: ReadonlyArray<string>): ReadonlyArray<string> =>
    useTags ? patterns.map((pattern) => `${TAGS_PREFIX}${pattern}`) : [];
  const result = await nameRev(ctx, rev, {
    tags: useTags,
    refs: scope(plan.include),
    exclude: scope(plan.exclude),
  });
  if (result.ref === undefined && !plan.always) throw cannotDescribe(result.oid);
  return result;
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

// Dirtiness is `git diff-index HEAD` over every tracked `status` column: a
// staged or unstaged change (every `changes` record carries at least one) or an
// unmerged path (a mid-merge index is dirty). Untracked files are a separate
// `status` field and never count (git's `--dirty`).
const computeDirty = async (ctx: Context, plan: ResolvedDescribePlan): Promise<boolean> => {
  if (!plan.dirty && !plan.broken) return false;
  try {
    const state = await status(ctx);
    return state.changes.length > 0 || state.unmerged.length > 0;
  } catch (err) {
    // Stryker disable next-line all: equivalent — defensive `--broken` tolerance:
    // `status` does not throw for a valid HEAD on the node/memory adapters, so
    // this catch has no reachable failure path to exercise in tests.
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
    const peeled = await peelRefToCommit(ctx, resolved.id);
    if (peeled === undefined) continue;
    const shortName = describeName(ref, plan.all);
    if (!filter.matches(shortName)) continue;
    const incoming = nameOf(ref, shortName, peeled);
    const existing = map.get(peeled.commit.id);
    if (existing === undefined || shouldReplaceName(existing, incoming)) {
      map.set(peeled.commit.id, incoming);
    }
  }
  return map;
};

const nameOf = (ref: RefName, shortName: string, peeled: PeeledRef): DescribeName => {
  const underTags = ref.startsWith(TAGS_PREFIX);
  const priority = underTags ? (peeled.viaTag ? 2 : 1) : 0;
  return { name: shortName, priority, taggerDate: peeled.taggerDate };
};

interface SelectionOutcome {
  readonly best: Candidate | undefined;
  readonly sawUnannotated: boolean;
}

/**
 * Date-ordered walk reproducing git's nearest-tag search. Drives the shared
 * `commitDateWalk` core (first-parent honoured) and layers describe's policy:
 * every popped commit advances the depth of each candidate it does not reach,
 * until the candidate set is frozen the moment every slot — or every name — is
 * taken (git's `gave_up_on`). The frozen set is sorted on its partial depths
 * (git's `compare_pt`) to pick the winner, whose depth is then finalised by
 * walking the remainder advancing the winner alone (git's
 * `finish_depth_computation`). git's secondary "covered path" break is omitted:
 * it cannot change the winner or its finalised depth, only the commits traversed.
 */
const selectNearest = async (
  ctx: Context,
  target: ObjectId,
  nameMap: ReadonlyMap<ObjectId, DescribeName>,
  plan: ResolvedDescribePlan,
  minPriority: number,
): Promise<SelectionOutcome> => {
  const totalNames = nameMap.size;
  const reach = new Map<ObjectId, Set<number>>();
  const candidates: Candidate[] = [];
  let counter = 0;
  let sawUnannotated = false;
  let winner: Candidate | undefined;

  for await (const commit of commitDateWalk(ctx, {
    from: [target],
    firstParent: plan.firstParent,
  })) {
    if (winner !== undefined) {
      finishWinner(reach, commit, winner, plan.firstParent);
      continue;
    }
    if (candidates.length === plan.maxCandidates || candidates.length === totalNames) {
      winner = pickNearest(candidates);
      if (winner === undefined) break;
      finishWinner(reach, commit, winner, plan.firstParent);
      continue;
    }
    const oid = commit.id;
    counter += 1;
    const named = nameMap.get(oid);
    if (named !== undefined && named.priority >= minPriority) {
      const index = candidates.length;
      candidates.push({
        name: named.name,
        commitOid: oid,
        depth: counter - 1,
        foundOrder: index,
      });
      reachSet(reach, oid).add(index);
    } else if (named !== undefined) {
      sawUnannotated = true;
    }
    incrementUnreached(candidates, reach.get(oid));
    propagateReach(reach, commit, plan.firstParent);
  }

  return { best: winner ?? pickNearest(candidates), sawUnannotated };
};

/** git's `compare_pt`: nearest (smallest depth) first, ties broken by found order. */
const pickNearest = (candidates: ReadonlyArray<Candidate>): Candidate | undefined =>
  [...candidates].sort(compareCandidates)[0];

/** Advance only the winner's depth (git's `finish_depth_computation`), still spreading reach. */
const finishWinner = (
  reach: Map<ObjectId, Set<number>>,
  commit: Commit,
  winner: Candidate,
  firstParent: boolean,
): void => {
  incrementUnreached([winner], reach.get(commit.id));
  propagateReach(reach, commit, firstParent);
};

const incrementUnreached = (
  candidates: ReadonlyArray<Candidate>,
  reached: Set<number> | undefined,
): void => {
  for (const candidate of candidates) {
    if (reached === undefined || !reached.has(candidate.foundOrder)) candidate.depth += 1;
  }
};

/** Spread a commit's reachability set to the parents the walk follows. */
const propagateReach = (
  reach: Map<ObjectId, Set<number>>,
  commit: Commit,
  firstParent: boolean,
): void => {
  const reachedHere = reach.get(commit.id);
  if (reachedHere === undefined) return;
  for (const parent of selectParents(commit, firstParent)) {
    const parentReach = reachSet(reach, parent);
    for (const index of reachedHere) parentReach.add(index);
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
