/**
 * Property test for git's merge option grammar: every spelling of a valued
 * option (`-Xv`, `-X v`, `--strategy-option=v`, `--strategy-option v`)
 * accumulates in order, the last fast-forward flag wins, a unique prefix of a
 * long option reads as the option, and nothing after `--` is read.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseMergeCommandLine } from '../../../../src/domain/merge/merge-command-line.js';

const ROUND_TRIP_RUNS = 200;

const value = fc.string({ minLength: 1 });

const spellings: ReadonlyArray<(v: string) => ReadonlyArray<string>> = [
  (v) => [`-X${v}`],
  (v) => ['-X', v],
  (v) => [`--strategy-option=${v}`],
  (v) => ['--strategy-option', v],
];

const spelt = fc.tuple(value, fc.nat({ max: spellings.length - 1 }));

const FAST_FORWARD_FLAGS = {
  '--ff': 'allow',
  '--no-ff': 'never',
  '--ff-only': 'only',
} as const;

describe('parseMergeCommandLine properties', () => {
  describe('Given any -X values, each in any spelling', () => {
    describe('When parsed', () => {
      it('Then they accumulate in order', () => {
        // Arrange
        const sut = parseMergeCommandLine;

        // Act & Assert
        fc.assert(
          fc.property(fc.array(spelt, { minLength: 1, maxLength: 5 }), (given) => {
            const argv = given.flatMap(([v, form]) => spellings[form]!(v));
            expect(sut(argv)).toEqual({ strategyOptions: given.map(([v]) => v) });
          }),
          { numRuns: ROUND_TRIP_RUNS },
        );
      });
    });
  });

  describe('Given any run of fast-forward flags', () => {
    describe('When parsed', () => {
      it('Then the last one wins', () => {
        // Arrange
        const sut = parseMergeCommandLine;
        const flags = fc.array(fc.constantFrom(...Object.keys(FAST_FORWARD_FLAGS)), {
          minLength: 1,
          maxLength: 6,
        });

        // Act & Assert
        fc.assert(
          fc.property(flags, (given) => {
            const last = given.at(-1) as keyof typeof FAST_FORWARD_FLAGS;
            expect(sut(given)).toEqual({ fastForward: FAST_FORWARD_FLAGS[last] });
          }),
        );
      });
    });
  });

  describe('Given any arguments after --', () => {
    describe('When parsed', () => {
      it('Then none of them is read', () => {
        // Arrange
        const sut = parseMergeCommandLine;

        // Act & Assert
        fc.assert(
          fc.property(fc.array(fc.string()), (rest) => {
            expect(sut(['--squash', '--', ...rest])).toEqual({ squash: true });
          }),
        );
      });
    });
  });

  describe('Given any prefix of a long option no other option shares', () => {
    describe('When parsed, alone and negated', () => {
      it('Then it reads as the whole option', () => {
        // Arrange
        const sut = parseMergeCommandLine;
        const SQUASH = 'squash';
        const UNIQUE_FROM = 3;

        // Act & Assert
        fc.assert(
          fc.property(fc.integer({ min: UNIQUE_FROM, max: SQUASH.length }), (length) => {
            const prefix = SQUASH.slice(0, length);
            expect(sut([`--${prefix}`])).toEqual({ squash: true });
            expect(sut([`--no-${prefix}`])).toEqual({ squash: false });
          }),
        );
      });
    });
  });
});
