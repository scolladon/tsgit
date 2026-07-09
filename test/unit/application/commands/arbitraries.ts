import fc from 'fast-check';

export type DagTag = {
  readonly commitIndex: number;
  readonly name: string;
};

/**
 * A commit DAG in creation order: entry i lists the parents of commit i, all
 * strictly earlier indices, so the graph is acyclic by construction. The
 * newest commit (last index) is the describe target.
 */
export type TaggedDagModel = {
  readonly parentSets: ReadonlyArray<ReadonlyArray<number>>;
  readonly tags: ReadonlyArray<DagTag>;
};

const MIN_COMMITS = 2;
const MAX_COMMITS = 12;
const MAX_TAGS = 1;

const linkedParents = (index: number): fc.Arbitrary<ReadonlyArray<number>> =>
  fc
    .tuple(
      fc.integer({ min: 0, max: index - 1 }),
      fc.option(fc.integer({ min: 0, max: index - 1 }), { nil: undefined }),
    )
    .map(([first, second]) =>
      second === undefined || second === first ? [first] : [first, second],
    );

const ORPHAN_ROOT_WEIGHT = 1;
const LINKED_WEIGHT = 9;

const parentsOf = (index: number): fc.Arbitrary<ReadonlyArray<number>> =>
  index === 0
    ? fc.constant([])
    : fc.oneof(
        { arbitrary: fc.constant<ReadonlyArray<number>>([]), weight: ORPHAN_ROOT_WEIGHT },
        { arbitrary: linkedParents(index), weight: LINKED_WEIGHT },
      );

const parentSetsArbitrary: fc.Arbitrary<ReadonlyArray<ReadonlyArray<number>>> = fc
  .integer({ min: MIN_COMMITS, max: MAX_COMMITS })
  .chain((size) => fc.tuple(...Array.from({ length: size }, (_, index) => parentsOf(index))));

/** Small random DAG (orphan roots allowed) with one annotated tag. */
export const taggedDagArbitrary: fc.Arbitrary<TaggedDagModel> = parentSetsArbitrary.chain(
  (parentSets) =>
    fc
      .uniqueArray(fc.integer({ min: 0, max: parentSets.length - 1 }), {
        minLength: 1,
        maxLength: MAX_TAGS,
      })
      .map((indices) => ({
        parentSets,
        tags: indices.map((commitIndex, ordinal) => ({
          commitIndex,
          name: `tag-${ordinal}`,
        })),
      })),
);
