/**
 * Property tests for `packedRefsWithout`: it is one half of a
 * parse/serialize pair (parse -> filter -> serialize), so its grammar-level
 * invariant is round-trip removal — proven here across arbitrary sorted,
 * peeled entry sets and arbitrary names, rather than the enumerated
 * examples in the sibling example file.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RefName } from '../../../../src/domain/objects/index.js';
import {
  packedRefsWithout,
  parsePackedRefs,
  serializePackedRefs,
} from '../../../../src/domain/refs/packed-refs.js';
import type { PackedRefEntry } from '../../../../src/domain/refs/ref-types.js';
import { arbObjectId } from '../objects/arbitraries.js';
import { arbRefName } from './arbitraries.js';

const ROUND_TRIP_NUM_RUNS = 200;
const IDEMPOTENCE_NUM_RUNS = 100;

/** One arbitrary entry, optionally peeled — `packedRefsWithout` must drop a
 *  peeled value together with its entry, never leave it orphaned. */
const arbEntry = (): fc.Arbitrary<PackedRefEntry> =>
  fc
    .tuple(arbRefName(), arbObjectId(), fc.option(arbObjectId(), { nil: undefined }))
    .map(([name, id, peeled]) => (peeled === undefined ? { name, id } : { name, id, peeled }));

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

describe('Given an arbitrary sorted, optionally-peeled entry set and a name', () => {
  describe('When packedRefsWithout removes that name from the serialized set', () => {
    it('Then parsing the result equals the original entries minus that name', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(
          fc.array(arbEntry(), { minLength: 0, maxLength: 12 }),
          arbRefName(),
          (rawEntries, name) => {
            const entries = dedupeByName(rawEntries);
            const content = serializePackedRefs({ entries, peeling: 'fully', sorted: true });

            const result = packedRefsWithout(content, name);

            const expected = [...entries].filter((entry) => entry.name !== name).sort(byName);
            expect(parsePackedRefs(result).entries).toEqual(expected);
          },
        ),
        { numRuns: ROUND_TRIP_NUM_RUNS },
      );
    });
  });
});

describe('Given an arbitrary entry set with a name present in it', () => {
  describe('When that name is removed twice in a row', () => {
    it('Then the second removal is a no-op — equal to removing it once', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(
          fc.array(arbEntry(), { minLength: 1, maxLength: 12 }),
          fc.nat(),
          (rawEntries, pick) => {
            const entries = dedupeByName(rawEntries);
            if (entries.length === 0) return true;
            const target = entries[pick % entries.length] as PackedRefEntry;
            const content = serializePackedRefs({ entries, peeling: 'fully', sorted: true });

            const once = packedRefsWithout(content, target.name as RefName);
            const twice = packedRefsWithout(once, target.name as RefName);

            expect(twice).toBe(once);
            return true;
          },
        ),
        { numRuns: IDEMPOTENCE_NUM_RUNS },
      );
    });
  });
});
