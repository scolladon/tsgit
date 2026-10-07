/**
 * Property tests for makeScriptWithMerges.
 *
 * Lens 4 (counting invariant) fits: over an arbitrary history of picks and
 * merges, oldest first and all reachable from HEAD, every kept commit is
 * replayed exactly once — as `merge` when it has several parents, `pick`
 * otherwise — a skipped one never, and no label is defined twice. Branch names
 * are drawn from a pool that collides with each other, with `onto`, and with
 * `branch-point`, so the uniqueness rules are exercised. Skipped commits are
 * single-parent only: git does not queue a skipped merge's side as a tip.
 * Lenses 1–3 do not fit: the todo is never parsed back here, nothing is
 * matched, and the input type admits no refused value.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import {
  type MergesScriptInput,
  makeScriptWithMerges,
  type ScriptCommit,
} from '../../../../src/domain/rebase/index.js';

const NUM_RUNS = 100;
const MAX_COMMITS = 9;
const OUTSIDE: ReadonlyArray<ObjectId> = ['base', 'up', 'far'].map((name) => name as ObjectId);
const BRANCH_NAMES = ['topic', 'topic', 'onto', 'branch-point', 'Topic', '#', 'side'];
const SUBJECTS = ["Merge branch 'topic'", "Merge branch 'side' into main", 'work', ''];

const oidOf = (position: number): ObjectId => `c${position}` as ObjectId;

interface Draft {
  readonly parents: ReadonlyArray<ObjectId>;
  readonly subject: string;
  readonly skipped: boolean;
}

const arbParent = (position: number): fc.Arbitrary<ObjectId> =>
  position === 0
    ? fc.constantFrom(...OUTSIDE)
    : fc.oneof(fc.integer({ min: 0, max: position - 1 }).map(oidOf), fc.constantFrom(...OUTSIDE));

const arbDraft = (position: number): fc.Arbitrary<Draft> =>
  fc
    .record({
      parents: fc.uniqueArray(arbParent(position), { minLength: 0, maxLength: 3 }),
      subject: fc.constantFrom(...SUBJECTS),
      skipped: fc.boolean(),
    })
    .map((draft) => ({ ...draft, skipped: draft.skipped && draft.parents.length < 2 }));

/** Only HEAD's (the last commit's) ancestors are walked, as git's range walk would. */
const reachableFromHead = (commits: ReadonlyArray<ScriptCommit>): ReadonlyArray<ScriptCommit> => {
  const byId = new Map(commits.map((commit) => [commit.id, commit]));
  const reached = new Set<ObjectId>();
  const pending = commits.slice(-1).map(({ id }) => id);
  for (let oid = pending.pop(); oid !== undefined; oid = pending.pop()) {
    if (reached.has(oid) || !byId.has(oid)) continue;
    reached.add(oid);
    pending.push(...(byId.get(oid)?.parents ?? []));
  }
  return commits.filter(({ id }) => reached.has(id));
};

const arbInput: fc.Arbitrary<MergesScriptInput> = fc
  .integer({ min: 1, max: MAX_COMMITS })
  .chain((count) =>
    fc.tuple(
      fc.tuple(...Array.from({ length: count }, (_unused, position) => arbDraft(position))),
      fc.array(
        fc.tuple(
          fc.integer({ min: 0, max: count - 1 }).map(oidOf),
          fc.constantFrom(...BRANCH_NAMES),
        ),
      ),
      fc.boolean(),
    ),
  )
  .map(([drafts, names, rebaseCousins]) => ({
    commits: reachableFromHead(
      drafts.map((draft, position) => ({ id: oidOf(position), ...draft })),
    ),
    ontoBase: 'base' as ObjectId,
    branchNames: new Map(names),
    abbreviations: new Map(),
    outsideSubjects: new Map(),
    rebaseCousins,
  }));

describe('makeScriptWithMerges properties', () => {
  describe('Given an arbitrary history reachable from HEAD', () => {
    describe('When the --rebase-merges todo is generated', () => {
      it('Then each kept commit is replayed once, as merge or pick by its parent count', () => {
        fc.assert(
          fc.property(arbInput, (input) => {
            // Arrange
            const sut = makeScriptWithMerges;
            const kept = input.commits.filter(({ skipped }) => !skipped);

            // Act
            const result = sut(input);

            // Assert
            const replayed = result.flatMap((line) =>
              line.action === 'pick' || line.action === 'merge'
                ? [`${line.action} ${line.oid}`]
                : [],
            );
            const expected = kept.map(
              ({ id, parents }) => `${parents.length > 1 ? 'merge' : 'pick'} ${id}`,
            );
            expect([...replayed].sort()).toEqual([...expected].sort());
          }),
          { numRuns: NUM_RUNS },
        );
      });

      it('Then no label is defined twice', () => {
        fc.assert(
          fc.property(arbInput, (input) => {
            // Arrange
            const sut = makeScriptWithMerges;

            // Act
            const result = sut(input);

            // Assert
            const labels = result.flatMap((line) => (line.action === 'label' ? [line.label] : []));
            expect(new Set(labels).size).toBe(labels.length);
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
});
