import fc from 'fast-check';
import type { NameRevStep, RevName } from '../../../../src/domain/name-rev/types.js';

/** An arbitrary `RevName`; only the comparator-relevant fields vary widely. */
export const revNameArb: fc.Arbitrary<RevName> = fc.record({
  ref: fc
    .constantFrom('refs/tags/a', 'refs/heads/b', 'refs/remotes/o/c')
    .map((name) => name as RevName['ref']),
  tagDeref: fc.boolean(),
  fromTag: fc.boolean(),
  taggerDate: fc.integer({ min: 0, max: 5 }),
  generation: fc.integer({ min: 0, max: 4 }),
  distance: fc.integer({ min: 0, max: 200_000 }),
  steps: fc.array(
    fc.oneof(
      fc.integer({ min: 1, max: 4 }).map((count): NameRevStep => ({ kind: 'ancestor', count })),
      fc.integer({ min: 2, max: 4 }).map((number): NameRevStep => ({ kind: 'parent', number })),
    ),
    { maxLength: 4 },
  ),
});
