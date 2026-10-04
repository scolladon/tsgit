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
import { computeClosure } from './internal/closure-engine.js';
import { markNotSide } from './internal/closure-not-marks.js';
import { limitList, readShown, resolveLimitOptions } from './internal/limit-list.js';
import { resolveTagChain } from './internal/object-emit.js';
import { MAX_PUSH_OBJECTS } from './types.js';

export interface EnumerateBundleObjectsInput {
  /** Positive endpoint oids — commits or annotated tags. */
  readonly wants: ReadonlyArray<ObjectId>;
  /** Excluded oids — explicit excludes of any type, or computed merge-bases. */
  readonly haves: ReadonlyArray<ObjectId>;
  /** Hard cap on total emitted objects. Defaults to MAX_PUSH_OBJECTS. */
  readonly maxObjects?: number;
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

/**
 * git's `--boundary` walk of the bundle's revisions: the uninteresting
 * parents of every commit the limited walk lists, in walk order, and every
 * object the walk leaves flagged uninteresting.
 */
const walkBundle = async (
  ctx: Context,
  wants: ReadonlyArray<ObjectId>,
  haves: ReadonlyArray<ObjectId>,
): Promise<BundleWalk> => {
  if (haves.length === 0) return NOTHING_EXCLUDED;
  const marks = await markNotSide(ctx, haves, { objects: true });
  const from = await Promise.all(
    wants.map((want) => resolveTagChain(ctx, undefined, want, IGNORE_TAG)),
  );
  const options = await resolveLimitOptions(
    ctx,
    { from, ignoreMissing: true },
    { until: new Set(marks.commitTips), firstParent: false, settle: 'slop' },
  );
  const walk = await limitList(ctx, options);
  const boundary = new Set<ObjectId>();
  for await (const commit of readShown(ctx, options, walk)) {
    for (const parent of commit.data.parents) {
      if (walk.uninteresting.has(parent)) boundary.add(parent);
    }
  }
  return {
    boundary: [...boundary],
    uninteresting: new Set([...marks.objects, ...walk.uninteresting]),
  };
};

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
  const { boundary, uninteresting } = await walkBundle(ctx, input.wants, input.haves);
  const closure = await computeClosure(ctx, {
    wants: input.wants,
    not: [...input.haves, ...boundary],
    objects: true,
    tier: 'bitmap',
  });
  assertWithinCap(closure.objects.length, input.maxObjects ?? MAX_PUSH_OBJECTS);
  return { objects: closure.objects, boundary, uninteresting };
};
