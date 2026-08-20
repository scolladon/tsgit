/**
 * Property test for `enumerateExtensionEntries` — a counting/order invariant
 * (lens 4): N generated `[extensions]` entries in a config text yield N
 * reported names, in the same order, each subsection-qualified and
 * key-lower-cased. The version parse and the acceptance predicate are
 * excluded (design's own verdict under CLAUDE.md's four lenses) — the
 * enumerator is the one honest candidate.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { tokenizeConfig } from '../../../src/domain/config/config-ini.js';
import { enumerateExtensionEntries } from '../../../src/repository/read-repository-format.js';
import { arbConfigKey, arbSegment } from './arbitraries.js';

const COMPOSITION_NUM_RUNS = 100;

/** One generated `[extensions]` entry: an optional subsection, a key, and a value. */
interface ArbExtensionEntry {
  readonly subsection: string | undefined;
  readonly key: string;
  readonly value: string;
}

const arbExtensionEntry = (): fc.Arbitrary<ArbExtensionEntry> =>
  fc.record({
    subsection: fc.option(arbSegment(), { nil: undefined }),
    key: arbConfigKey(),
    value: arbSegment(),
  });

/** Renders N generated entries as N `[extensions]` (or `[extensions "x"]`) blocks, one entry each, in order. */
const renderExtensionsConfig = (entries: ReadonlyArray<ArbExtensionEntry>): string =>
  entries
    .map((entry) => {
      const header =
        entry.subsection === undefined ? '[extensions]' : `[extensions "${entry.subsection}"]`;
      return `${header}\n\t${entry.key} = ${entry.value}\n`;
    })
    .join('');

describe('enumerateExtensionEntries properties', () => {
  describe('Given an arbitrary sequence of [extensions] entries', () => {
    describe('When enumerateExtensionEntries runs', () => {
      it('Then it returns exactly N entries, in order, subsection-qualified and key-lower-cased', () => {
        // Arrange
        const sut = enumerateExtensionEntries;

        // Act & Assert
        fc.assert(
          fc.property(fc.array(arbExtensionEntry(), { minLength: 0, maxLength: 8 }), (entries) => {
            const text = renderExtensionsConfig(entries);
            const tokens = tokenizeConfig(text, '/repo/.git/config');

            const result = sut(tokens);

            expect(result).toHaveLength(entries.length);
            entries.forEach((entry, index) => {
              const expectedKey = entry.key.toLowerCase();
              const expectedName =
                entry.subsection === undefined ? expectedKey : `${entry.subsection}.${expectedKey}`;
              expect(result[index]?.name).toBe(expectedName);
              expect(result[index]?.key).toBe(expectedKey);
              expect(result[index]?.subsection).toBe(entry.subsection);
            });
          }),
          { numRuns: COMPOSITION_NUM_RUNS },
        );
      });
    });
  });
});
