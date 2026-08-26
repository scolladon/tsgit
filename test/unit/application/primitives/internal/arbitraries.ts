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
): fc.Arbitrary<ReadonlyArray<TreePathShapeEntry>> {
  return fc
    .uniqueArray(arbTreePathName(), { minLength: 0, maxLength: TREE_PATH_MAX_BREADTH })
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

export const treePathShapeArb = (): fc.Arbitrary<ReadonlyArray<TreePathShapeEntry>> =>
  arbTreePathChildren(TREE_PATH_MAX_DEPTH);

/** A `/`-joined path drawn from the same name pool, 1 to depth+1 segments. */
export const treePathArb = (): fc.Arbitrary<string> =>
  fc
    .array(arbTreePathName(), { minLength: 1, maxLength: TREE_PATH_MAX_DEPTH + 1 })
    .map((segments) => segments.join('/'));

/**
 * A duplicate entry name, a disjoint set of sibling names (the pool minus
 * the duplicate itself), and a final search segment — irrelevant to whether
 * the refusal fires, since a full-directory scan sees the duplicate
 * regardless of what is being searched for. `duplicateName` is drawn first
 * via `.chain` so `siblings` can exclude it by construction.
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
        fc.constantFrom(...TREE_PATH_NAME_POOL),
      )
      .map(([siblings, searchSegment]) => ({ duplicateName, siblings, searchSegment })),
  );
