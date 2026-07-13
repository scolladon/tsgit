import fc from 'fast-check';

import type { SnapshotEntry } from '../../bench-to-snapshot.js';

const TSGIT_KEY_SUFFIX = ' > tsgit';

// Reserved for property tests that append a fixed extra scenario alongside
// an arbitrary set — excluded here so a generated name can never collide.
const RESERVED_SCENARIO_NAMES = new Set(['zzz-regress', 'zzz-stable']);

const arbScenarioName = (): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')), {
      minLength: 1,
      maxLength: 12,
    })
    .map((chars) => chars.join(''))
    .filter((name) => !RESERVED_SCENARIO_NAMES.has(name));

export const snapshotEntryArb = (): fc.Arbitrary<SnapshotEntry> =>
  fc
    .tuple(arbScenarioName(), fc.double({ min: 0.001, max: 100000, noNaN: true }))
    .map(([scenario, value]) => ({
      name: `${scenario}${TSGIT_KEY_SUFFIX}`,
      unit: 'ms' as const,
      value,
    }));

export const gatedEntrySetArb = (): fc.Arbitrary<readonly SnapshotEntry[]> =>
  fc
    .uniqueArray(snapshotEntryArb(), { selector: (entry) => entry.name, maxLength: 8 })
    .map((entries) => entries);
