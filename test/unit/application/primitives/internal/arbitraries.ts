import fc from 'fast-check';

/**
 * Shared property-test arbitraries for the `internal` primitives family.
 *
 * `resolve-tree-path.properties.test.ts`'s tree grammar: a small bounded
 * name pool (including two byte-for-byte prefix pairs) reused for both the
 * tree shape AND the search path, so generated paths land inside the tree,
 * past a non-tree intermediate, or nowhere at all, with no bookkeeping
 * tying a path to "the" tree it will be resolved against.
 */
export type TreePathShapeEntry =
  | { readonly kind: 'blob'; readonly name: string; readonly content: string }
  | { readonly kind: 'gitlink'; readonly name: string }
  | { readonly kind: 'symlink'; readonly name: string; readonly target: string }
  | {
      readonly kind: 'tree';
      readonly name: string;
      readonly children: ReadonlyArray<TreePathShapeEntry>;
    };

export const TREE_PATH_NAME_POOL = ['a', 'b', 'ab', 'ab.txt', 'missing'] as const;
const TREE_PATH_MAX_DEPTH = 3;
const TREE_PATH_MAX_BREADTH = 3;

const arbTreePathName = (): fc.Arbitrary<string> => fc.constantFrom(...TREE_PATH_NAME_POOL);

const arbLeafEntry = (name: string): fc.Arbitrary<TreePathShapeEntry> =>
  fc.oneof(
    fc
      .string({ maxLength: 6 })
      .map((content): TreePathShapeEntry => ({ kind: 'blob', name, content })),
    fc.constant<TreePathShapeEntry>({ kind: 'gitlink', name }),
    fc
      .string({ maxLength: 6 })
      .map((target): TreePathShapeEntry => ({ kind: 'symlink', name, target })),
  );

const arbTreePathEntry = (
  name: string,
  depthRemaining: number,
): fc.Arbitrary<TreePathShapeEntry> =>
  depthRemaining <= 0
    ? arbLeafEntry(name)
    : fc.oneof(
        { weight: 2, arbitrary: arbLeafEntry(name) },
        {
          weight: 1,
          arbitrary: arbTreePathChildren(depthRemaining - 1).map(
            (children): TreePathShapeEntry => ({ kind: 'tree', name, children }),
          ),
        },
      );

/**
 * Depth-bounded via an explicit countdown (not a self-referencing recursive
 * arbitrary), entry names within one level forced unique — a real git tree
 * can never hold two entries with the same name — by drawing without
 * replacement from the name pool, then folding one dependent per-name
 * arbitrary at a time (`.chain`).
 */
function arbTreePathChildren(
  depthRemaining: number,
  minLength = 0,
): fc.Arbitrary<ReadonlyArray<TreePathShapeEntry>> {
  return fc
    .uniqueArray(arbTreePathName(), { minLength, maxLength: TREE_PATH_MAX_BREADTH })
    .chain((names) =>
      names.reduce<fc.Arbitrary<TreePathShapeEntry[]>>(
        (acc, name) =>
          acc.chain((built) =>
            arbTreePathEntry(name, depthRemaining).map((entry) => [...built, entry]),
          ),
        fc.constant([]),
      ),
    );
}

// The root directory is forced non-empty (minLength: 1) so a "real" path
// drawn by `treePathArb` below always has at least one candidate to draw
// from — a run over an empty root would otherwise exercise only the trivial
// not-found case.
export const treePathShapeArb = (): fc.Arbitrary<ReadonlyArray<TreePathShapeEntry>> =>
  arbTreePathChildren(TREE_PATH_MAX_DEPTH, 1);

/** Every `/`-joined path reachable in `shape`, at every depth (files, gitlinks,
 *  symlinks, and directories themselves — a directory path is a legitimate
 *  "intermediate segment" probe when extended further by the random arm). */
function realPathsIn(
  shape: ReadonlyArray<TreePathShapeEntry>,
  prefix: ReadonlyArray<string> = [],
): ReadonlyArray<ReadonlyArray<string>> {
  return shape.flatMap((entry) => {
    const path = [...prefix, entry.name];
    return entry.kind === 'tree' ? [path, ...realPathsIn(entry.children, path)] : [path];
  });
}

/**
 * A path drawn OFF the materialised shape (`.chain`), so most runs target a
 * segment sequence that actually exists somewhere in the tree — resolving to
 * a real entry, a real directory (probed one segment too far), or a real
 * leaf (probed one segment too far past it) — mixed with a fully random path
 * (independent of the shape) to keep exercising the "nowhere in the tree"
 * case. Without this, a path drawn independently of the shape almost never
 * lands inside it (`treeInterop`d empty-vs-real name pool), so the property
 * mostly proves the trivial `undefined === undefined` case.
 */
export const treePathArb = (shape: ReadonlyArray<TreePathShapeEntry>): fc.Arbitrary<string> => {
  const randomPathArb = fc
    .array(arbTreePathName(), { minLength: 1, maxLength: TREE_PATH_MAX_DEPTH + 1 })
    .map((segments) => segments.join('/'));
  const real = realPathsIn(shape);
  if (real.length === 0) return randomPathArb;
  const realPathArb = fc
    .constantFrom(...real)
    .chain((segments) =>
      fc.oneof(
        fc.constant(segments),
        arbTreePathName().map((extra) => [...segments, extra]),
      ),
    )
    .map((segments) => segments.join('/'));
  return fc.oneof({ weight: 2, arbitrary: realPathArb }, { weight: 1, arbitrary: randomPathArb });
};

/**
 * A duplicate entry name and a disjoint set of sibling names (the pool minus
 * the duplicate itself) — the caller assigns each sibling and each of the
 * duplicate's two occurrences its own distinct blob id, so resolving to the
 * WRONG entry (a sibling, or the second duplicate) is observable rather than
 * masked by every candidate sharing one id. `searchSegment` mostly equals
 * `duplicateName` (the case this arbitrary exists to probe); the remaining
 * weight still draws from the pool, covering the plain single-entry lookup
 * and the "not present" miss. `duplicateName` is drawn first via `.chain` so
 * `siblings` can exclude it by construction.
 */
export interface DuplicateDirectorySpec {
  readonly duplicateName: string;
  readonly siblings: ReadonlyArray<string>;
  readonly searchSegment: string;
}

export const duplicateDirectoryArb = (): fc.Arbitrary<DuplicateDirectorySpec> =>
  fc.constantFrom(...TREE_PATH_NAME_POOL).chain((duplicateName) =>
    fc
      .tuple(
        fc
          .uniqueArray(arbTreePathName(), { maxLength: TREE_PATH_MAX_BREADTH })
          .map((names) => names.filter((name) => name !== duplicateName)),
        fc.oneof(
          { weight: 4, arbitrary: fc.constant(duplicateName) },
          { weight: 1, arbitrary: fc.constantFrom(...TREE_PATH_NAME_POOL) },
        ),
      )
      .map(([siblings, searchSegment]) => ({ duplicateName, siblings, searchSegment })),
  );
