import fc from 'fast-check';

export interface ThreeWay {
  readonly base: string;
  readonly ours: string;
  readonly theirs: string;
}

// Replacement lines drawn from a tiny alphabet so sides frequently share content
// (exercising prefix/suffix trimming) and frequently collide (exercising conflicts).
const arbTag = (): fc.Arbitrary<string> => fc.constantFrom('p\n', 'q\n', 'r\n', 's\n');

const baseOf = (n: number): ReadonlyArray<string> => Array.from({ length: n }, (_, i) => `b${i}\n`);

const applyDecisions = (
  base: ReadonlyArray<string>,
  decisions: ReadonlyArray<string | null>,
  predicate: (index: number) => boolean,
): string => base.map((line, i) => (predicate(i) ? (decisions[i] ?? line) : line)).join('');

/**
 * A 3-way input where each side independently keeps or replaces each base line.
 * Overlapping replacements at the same index produce conflict regions; matching
 * keeps produce shared context. Always non-binary and small (never degrades).
 */
export const arbThreeWay = (): fc.Arbitrary<ThreeWay> =>
  fc.integer({ min: 1, max: 10 }).chain((n) => {
    const base = baseOf(n);
    const side = (): fc.Arbitrary<ReadonlyArray<string | null>> =>
      fc.array(fc.option(arbTag(), { nil: null }), { minLength: n, maxLength: n });
    return fc.record({ ours: side(), theirs: side() }).map(({ ours, theirs }) => ({
      base: base.join(''),
      ours: applyDecisions(base, ours, () => true),
      theirs: applyDecisions(base, theirs, () => true),
    }));
  });

/**
 * A 3-way input where ours edits only the first half of the base lines and
 * theirs only the second half — the two edit scripts touch disjoint base ranges,
 * so the merge never conflicts.
 */
export const arbDisjointThreeWay = (): fc.Arbitrary<ThreeWay> =>
  fc.integer({ min: 2, max: 10 }).chain((n) => {
    const base = baseOf(n);
    const mid = Math.floor(n / 2);
    return fc
      .record({
        ours: fc.array(fc.option(arbTag(), { nil: null }), { minLength: n, maxLength: n }),
        theirs: fc.array(fc.option(arbTag(), { nil: null }), { minLength: n, maxLength: n }),
      })
      .map(({ ours, theirs }) => ({
        base: base.join(''),
        ours: applyDecisions(base, ours, (i) => i < mid),
        theirs: applyDecisions(base, theirs, (i) => i >= mid),
      }));
  });

export interface UniquePathInput {
  readonly base: string;
  readonly label: string;
  readonly stem: string;
  readonly reserved: Set<string>;
}

/**
 * An input for the rename-target prober: a slash-free base path and label
 * (flattenLabel is identity without slashes), and a reserved set drawn from an
 * 11-bit mask — bit 10 occupies the stem itself, bits 0–9 occupy stem_0…stem_9.
 * Leaving the stem free keeps the "returns the stem" branch live.
 */
export const arbUniquePathInput = (): fc.Arbitrary<UniquePathInput> =>
  fc
    .record({
      base: fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/),
      label: fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/),
      mask: fc.integer({ min: 0, max: 2047 }),
    })
    .map(({ base, label, mask }) => {
      const stem = `${base}~${label}`;
      const reserved = new Set<string>();
      if (mask & 1024) reserved.add(stem);
      for (let k = 0; k < 10; k++) {
        if (mask & (1 << k)) {
          reserved.add(`${stem}_${k}`);
        }
      }
      return { base, label, stem, reserved };
    });
