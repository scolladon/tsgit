/**
 * Bundle object and boundary enumeration — what `git bundle create` packs and
 * lists as prerequisites.
 *
 * git computes the prerequisites with a `--boundary` limited walk of the
 * bundle's revisions, then hands those revisions plus a `^` line per
 * prerequisite to `pack-objects --thin`. Both steps are reproduced here:
 * the boundary is every uninteresting parent of a commit git's `limit_list`
 * lists (so a clock-skewed have line it gives up on leaves its shared
 * ancestor bundled, not required), and the objects are the shared closure
 * engine's answer for the same wants and excludes — the walk marks only edge
 * trees uninteresting, and a usable bitmap answers the exact difference, as
 * git's own `pack-objects` does.
 */
import { TsgitError } from '../../domain/error.js';
import type { ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { type ClosureTip, computeClosure } from './internal/closure-engine.js';
import {
  createNotMarks,
  markNotTip,
  type NotMarksAccumulator,
} from './internal/closure-not-marks.js';
import { type LimitedWalk, limitOrFailSetup, resolveLimitOptions } from './internal/limit-list.js';
import { resolveTagChain } from './internal/object-emit.js';
import { createObjectTypeTable, type ObjectTypeTable } from './internal/object-type-table.js';
import { MAX_PUSH_OBJECTS } from './types.js';

export interface EnumerateBundleObjectsInput {
  /** Positive endpoint oids — commits or annotated tags. */
  readonly wants: ReadonlyArray<ObjectId>;
  /** Excluded oids — explicit excludes of any type, or computed merge-bases. */
  readonly haves: ReadonlyArray<ObjectId>;
  /**
   * `wants` and `haves` in git's pending (command-line) order — the order
   * the bundle walk and its `pack-objects` feed type and pop them in.
   * Omitted means `wants`, then `haves`.
   */
  readonly tips?: ReadonlyArray<ClosureTip>;
  /** Hard cap on total emitted objects. Defaults to MAX_PUSH_OBJECTS. */
  readonly maxObjects?: number;
  /**
   * The bundle process's object-type table, holding what its argument
   * parsing already typed; its walk types into it. Omitted means a fresh one.
   */
  readonly objectTypes?: ObjectTypeTable;
}

/** An object id paired with git's `pack_name_hash` of its own path — `0`
 *  for a tag or a commit, neither of which has a path, and absent when a
 *  bitmap answered, since a bitmap encodes no names. */
export interface BundleObjectEntry {
  readonly id: ObjectId;
  readonly nameHash?: number;
}

export interface BundleObjectClosure {
  /**
   * Deduped object set for pack building: tags + commits + trees + blobs,
   * each paired with git's `pack_name_hash` of its own path. A tag or a
   * commit — neither has a path — carries `0`.
   */
  readonly objects: ReadonlyArray<BundleObjectEntry>;
  /**
   * Boundary commit oids — commits in the uninteresting closure that are
   * direct parents of interesting commits. UNSORTED: the caller sorts by
   * oid ascending before serialising the bundle header.
   */
  readonly boundary: ReadonlyArray<ObjectId>;
  /**
   * Every object git's bundle walk leaves flagged uninteresting: a commit
   * the limited walk marks, an excluded tag and what it peels to, and an
   * excluded tree with all it holds. A boundary commit's own tree is NOT
   * among them — only `pack-objects` marks it — so a ref naming it stays.
   */
  readonly uninteresting: ReadonlySet<ObjectId>;
}

const IGNORE_TAG = (): void => {};

const NOTHING_EXCLUDED: BundleWalk = { boundary: [], uninteresting: new Set() };

type BundleWalk = Pick<BundleObjectClosure, 'boundary' | 'uninteresting'>;

/** The commits the bundle walk starts from, in pending order, and those it seeds. */
interface BundleSeeds {
  readonly from: ObjectId[];
  readonly seeds: ObjectId[];
}

/**
 * git's `prepare_revision_walk` over the bundle's pending tips: an excluded
 * one marked, a wanted one peeled, each commit seeded in that order.
 */
const seedInOrder = async (
  ctx: Context,
  tips: ReadonlyArray<ClosureTip>,
  marks: NotMarksAccumulator,
  objectTypes: ObjectTypeTable,
): Promise<BundleSeeds> => {
  const seeded: BundleSeeds = { from: [], seeds: [] };
  for (const tip of tips) {
    if (tip.excluded) {
      const commit = await markNotTip(ctx, tip.id, marks);
      if (commit !== undefined) seeded.seeds.push(commit);
      continue;
    }
    const peeled = await resolveTagChain(ctx, objectTypes, tip.id, IGNORE_TAG);
    seeded.from.push(peeled);
    seeded.seeds.push(peeled);
  }
  return seeded;
};

/** git's limited walk from the seeded tips down to the excluded ones' marks. */
const limitBundleRevisions = async (
  ctx: Context,
  { from, seeds }: BundleSeeds,
  marks: NotMarksAccumulator,
  objectTypes: ObjectTypeTable,
): Promise<LimitedWalk> => {
  const options = await resolveLimitOptions(
    ctx,
    { from },
    {
      seeds,
      until: new Set(marks.commitTips),
      firstParent: false,
      settle: 'slop',
      objectTypes,
      bodyRetention: 'none',
    },
  );
  return limitOrFailSetup(ctx, options);
};

/** The uninteresting parents of every listed commit, in walk order. */
const boundaryOf = (walk: LimitedWalk): ReadonlyArray<ObjectId> => [
  ...new Set(
    walk.shownHeads.flatMap((commit) =>
      commit.parents.filter((parent) => walk.uninteresting.has(parent)),
    ),
  ),
];

/**
 * git's `--boundary` walk of the bundle's revisions, typed into the bundle
 * process's own table: the uninteresting parents of every commit the limited
 * walk lists, in walk order, and every object the walk leaves flagged
 * uninteresting.
 */
const walkBundle = async (
  ctx: Context,
  tips: ReadonlyArray<ClosureTip>,
  objectTypes: ObjectTypeTable,
): Promise<BundleWalk> => {
  if (tips.every((tip) => !tip.excluded)) return NOTHING_EXCLUDED;
  const marks = await createNotMarks(ctx, { objects: true, objectTypes });
  const seeded = await seedInOrder(ctx, tips, marks, objectTypes);
  const walk = await limitBundleRevisions(ctx, seeded, marks, objectTypes);
  return {
    boundary: boundaryOf(walk),
    uninteresting: new Set([...marks.objects, ...walk.uninteresting]),
  };
};

/**
 * git's `write_pack_data` feed: each pending tip, excluded once the bundle
 * walk flagged it, then each prerequisite.
 */
const packFeed = (
  tips: ReadonlyArray<ClosureTip>,
  walked: BundleWalk,
): ReadonlyArray<ClosureTip> => [
  ...tips.map(({ id, excluded }) => ({ id, excluded: excluded || walked.uninteresting.has(id) })),
  ...walked.boundary.map((id) => ({ id, excluded: true })),
];

const pendingOf = (input: EnumerateBundleObjectsInput): ReadonlyArray<ClosureTip> =>
  input.tips ?? [
    ...input.wants.map((id) => ({ id, excluded: false })),
    ...input.haves.map((id) => ({ id, excluded: true })),
  ];

/** `tryEmit`'s own refusal, for a closure that outgrew the caller's cap. */
const assertWithinCap = (count: number, cap: number): void => {
  if (count <= cap) return;
  throw new TsgitError({ code: 'PACK_TOO_LARGE', objectCount: cap + 1, limit: cap });
};

export const enumerateBundleObjects = async (
  ctx: Context,
  input: EnumerateBundleObjectsInput,
): Promise<BundleObjectClosure> => {
  if (input.wants.length === 0) return { objects: [], ...NOTHING_EXCLUDED };
  const tips = pendingOf(input);
  const walked = await walkBundle(ctx, tips, input.objectTypes ?? createObjectTypeTable());
  const { boundary, uninteresting } = walked;
  const closure = await computeClosure(ctx, {
    wants: input.wants,
    not: [...input.haves, ...boundary],
    tips: packFeed(tips, walked),
    objects: true,
    tier: 'bitmap',
    objectTypes: createObjectTypeTable(),
  });
  assertWithinCap(closure.objects.length, input.maxObjects ?? MAX_PUSH_OBJECTS);
  return { objects: closure.objects, boundary, uninteresting };
};
