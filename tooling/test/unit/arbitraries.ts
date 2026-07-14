import fc from 'fast-check';

import type { SnapshotEntry } from '../../bench-to-snapshot.js';

const TSGIT_KEY_SUFFIX = ' > tsgit';

// Reserved for property tests that append a fixed extra scenario alongside
// an arbitrary set — excluded here so a generated name can never collide.
const RESERVED_SCENARIO_NAMES = new Set(['zzz-regress', 'zzz-stable']);

// Built from character-code ranges rather than a literal alphabet string so an
// entropy-based secrets scanner has no long literal to mistake for a credential.
const codePoints = (start: string, end: string): string[] =>
  Array.from({ length: end.charCodeAt(0) - start.charCodeAt(0) + 1 }, (_, i) =>
    String.fromCharCode(start.charCodeAt(0) + i),
  );
const NAME_CHARS = [...codePoints('a', 'z'), ...codePoints('0', '9'), '-', '_'];

const arbScenarioName = (): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...NAME_CHARS), { minLength: 1, maxLength: 12 })
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
