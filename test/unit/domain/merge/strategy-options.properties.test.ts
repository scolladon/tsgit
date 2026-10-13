/**
 * Property tests for parseOrtStrategyOptions.
 *
 * Lens 3 (total function) fits: any list of `-X` values, drawn from the known
 * spellings, their `=`-valued prefixes with arbitrary tails, and free text,
 * either parses to settings whose rename threshold stays on the 0..MAX_SCORE
 * scale or is refused with data naming one of the given options — never a raw
 * runtime error. Lenses 1, 2 and 4 do not fit: there is no serializer, no
 * matcher, and the last-one-wins fold has no feature to count.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_SCORE } from '../../../../src/domain/diff/similarity.js';
import { TsgitError } from '../../../../src/domain/error.js';
import { parseOrtStrategyOptions } from '../../../../src/domain/merge/strategy-options.js';

const NUM_RUNS = 100;
const KNOWN_OPTIONS = [
  'ours',
  'theirs',
  'subtree',
  'renormalize',
  'no-renormalize',
  'no-renames',
  'find-renames',
  'patience',
  'histogram',
  'ignore-space-at-eol',
  'ignore-space-change',
  'ignore-all-space',
  'ignore-cr-at-eol',
];
const VALUED_PREFIXES = ['find-renames=', 'rename-threshold=', 'diff-algorithm=', 'subtree='];

const arbTail = fc.stringMatching(/^[0-9.%a-zA-Z-]{0,6}$/);
const arbOption = fc.oneof(
  fc.constantFrom(...KNOWN_OPTIONS),
  fc.tuple(fc.constantFrom(...VALUED_PREFIXES), arbTail).map(([prefix, tail]) => prefix + tail),
  fc.string({ maxLength: 8 }),
);

/** The parse's value, or what it threw. */
const outcomeOf = (run: () => unknown): unknown => {
  try {
    return run();
  } catch (error) {
    return error;
  }
};

const expectKnownRefusal = (error: TsgitError, options: ReadonlyArray<string>): void => {
  expect(error.data.code).toBe('UNKNOWN_STRATEGY_OPTION');
  expect(options).toContain((error.data as { readonly option: string }).option);
};

const lastRenormalizeOption = (options: ReadonlyArray<string>): string | undefined =>
  options.filter((o) => o === 'renormalize' || o === 'no-renormalize').at(-1);

describe('parseOrtStrategyOptions properties', () => {
  describe('Given an arbitrary list of -X values', () => {
    describe('When parsed', () => {
      it('Then it yields settings on the score scale or refuses with data naming an option', () => {
        fc.assert(
          fc.property(fc.array(arbOption, { maxLength: 5 }), (options) => {
            // Arrange
            const sut = parseOrtStrategyOptions;

            // Act
            const result = outcomeOf(() => sut(options));

            // Assert
            if (result instanceof TsgitError) {
              expectKnownRefusal(result, options);
              return;
            }
            const threshold =
              (result as ReturnType<typeof parseOrtStrategyOptions>).renames.threshold ?? 0;
            expect(threshold).toBeGreaterThanOrEqual(0);
            expect(threshold).toBeLessThanOrEqual(MAX_SCORE);
            const last = lastRenormalizeOption(options);
            expect((result as ReturnType<typeof parseOrtStrategyOptions>).renormalize).toBe(
              last === undefined ? undefined : last === 'renormalize',
            );
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
});
