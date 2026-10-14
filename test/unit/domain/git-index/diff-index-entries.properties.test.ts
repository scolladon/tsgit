import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { diffIndexEntries } from '../../../../src/domain/git-index/diff-index-entries.js';
import type { IndexEntry } from '../../../../src/domain/git-index/index-entry.js';
import { arbIndexEntry } from './arbitraries.js';

const NUM_RUNS = 100;

const key = (e: IndexEntry): string => `${e.path}\0${e.flags.stage}\0${e.id}\0${e.mode}`;
const keySet = (list: ReadonlyArray<IndexEntry>): ReadonlySet<string> => new Set(list.map(key));
const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && [...a].every((k) => b.has(k));
const arbList = fc.array(arbIndexEntry(), { maxLength: 8 });
const arbPair = fc
  .tuple(arbList, arbList)
  .chain(([base, extra]) =>
    fc.constantFrom(base, [...base, ...extra]).map((after) => [base, after] as const),
  );

describe('diffIndexEntries properties', () => {
  describe('Given any two lists', () => {
    it('Then changedPaths is empty iff both agree on (path, stage, id, mode)', () => {
      fc.assert(
        fc.property(arbList, arbPair, (other, [before, after]) => {
          for (const [a, b] of [
            [before, after],
            [before, other],
          ] as const) {
            const sut = diffIndexEntries(a, b);
            expect(sut.changedPaths.length === 0).toBe(sameSet(keySet(a), keySet(b)));
          }
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('Then trackedSetChanged is symmetric', () => {
      fc.assert(
        fc.property(arbList, arbList, (a, b) => {
          expect(diffIndexEntries(a, b).trackedSetChanged).toBe(
            diffIndexEntries(b, a).trackedSetChanged,
          );
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('Then the result is independent of input order', () => {
      fc.assert(
        fc.property(
          fc
            .tuple(arbList, arbList)
            .chain(([a, b]) =>
              fc.tuple(
                fc.constant(a),
                fc.constant(b),
                fc.shuffledSubarray(a, { minLength: a.length }),
                fc.shuffledSubarray(b, { minLength: b.length }),
              ),
            ),
          ([a, b, shuffledA, shuffledB]) => {
            expect(diffIndexEntries(shuffledA, shuffledB)).toEqual(diffIndexEntries(a, b));
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it('Then diffing a list against itself is empty', () => {
      fc.assert(
        fc.property(arbList, (x) => {
          expect(diffIndexEntries(x, x)).toEqual({
            changedPaths: [],
            trackedSetChanged: false,
            resolvedUnmerged: false,
          });
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });
});
