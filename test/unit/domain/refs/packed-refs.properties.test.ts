/**
 * Property tests for `packedRefsWithout`: it is one half of a
 * filter/serialize pair whose other half is `parsePackedRefs`, so its
 * grammar-level invariant is round-trip removal — proven here across
 * arbitrary sorted, peeled entry sets and names drawn mostly from those
 * entries, rather than the enumerated examples in the sibling example file.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RefName } from '../../../../src/domain/objects/index.js';
import { packedRefsWithout, parsePackedRefs } from '../../../../src/domain/refs/packed-refs.js';
import type { PackedRefEntry } from '../../../../src/domain/refs/ref-types.js';
import { arbPackedRefEntry, arbRefName } from './arbitraries.js';

const ROUND_TRIP_NUM_RUNS = 200;
const IDEMPOTENCE_NUM_RUNS = 100;
/** How much more often a removed name is drawn from the entries than
 *  generated fresh — a fresh name almost never collides with an entry. */
const PRESENT_NAME_WEIGHT = 4;

const byName = (a: PackedRefEntry, b: PackedRefEntry): number =>
  (a.name as string) < (b.name as string) ? -1 : (a.name as string) > (b.name as string) ? 1 : 0;

const dedupeByName = (entries: readonly PackedRefEntry[]): readonly PackedRefEntry[] => {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.name as string)) return false;
    seen.add(entry.name as string);
    return true;
  });
};

/** git hands this function a SNAPSHOT — sorted, because `create_snapshot`
 *  sorts any file that does not already claim the trait. */
const sortedByName = (entries: readonly PackedRefEntry[]): readonly PackedRefEntry[] =>
  [...entries].sort(byName);

/** A deduplicated, sorted entry set and a set of names to remove, mostly drawn from it. */
const arbEntriesAndNames = (): fc.Arbitrary<
  readonly [readonly PackedRefEntry[], ReadonlySet<RefName>]
> =>
  fc
    .array(arbPackedRefEntry(), { minLength: 1, maxLength: 12 })
    .map(dedupeByName)
    .map(sortedByName)
    .chain((entries) => {
      const present = fc.constantFrom(...entries.map((entry) => entry.name));
      const name = fc.oneof(
        { weight: PRESENT_NAME_WEIGHT, arbitrary: present },
        { weight: 1, arbitrary: arbRefName() },
      );
      const names = fc.array(name, { minLength: 1, maxLength: 3 }).map((list) => new Set(list));
      return fc.tuple(fc.constant(entries), names);
    });

describe('Given an arbitrary sorted, optionally-peeled entry set and names mostly drawn from it', () => {
  describe('When packedRefsWithout removes those names', () => {
    it('Then parsing the rewrite equals the entries minus those names, and the returned entries match it', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbEntriesAndNames(), ([entries, names]) => {
          const sut = packedRefsWithout;

          const result = sut(entries, names);

          const expected = entries.filter((entry) => !names.has(entry.name));
          expect(parsePackedRefs(result.content).entries).toEqual(expected);
          expect(result.entries).toEqual(expected);
        }),
        { numRuns: ROUND_TRIP_NUM_RUNS },
      );
    });
  });
});

describe('Given an arbitrary sorted entry set with a name present in it', () => {
  describe('When that name is removed twice in a row', () => {
    it('Then the first removal drops exactly that entry and the second is a no-op', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(
          fc
            .array(arbPackedRefEntry(), { minLength: 1, maxLength: 12 })
            .map(dedupeByName)
            .map(sortedByName),
          fc.nat(),
          (entries, pick) => {
            const sut = packedRefsWithout;
            const target = entries[pick % entries.length] as PackedRefEntry;
            const names = new Set([target.name]);

            const once = sut(entries, names);
            const twice = sut(parsePackedRefs(once.content).entries, names);

            const survivors = parsePackedRefs(once.content).entries;
            expect(survivors.some((entry) => entry.name === target.name)).toBe(false);
            expect(survivors).toHaveLength(entries.length - 1);
            expect(twice.content).toBe(once.content);
          },
        ),
        { numRuns: IDEMPOTENCE_NUM_RUNS },
      );
    });
  });
});
