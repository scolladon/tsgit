import { describe, expect, it } from 'vitest';
import { TsgitError } from '../../../../src/domain/error.js';
import {
  diffAlgorithmValue,
  parseOrtStrategyOptions,
} from '../../../../src/domain/merge/strategy-options.js';

const failureOf = (options: ReadonlyArray<string>): unknown => {
  try {
    parseOrtStrategyOptions(options);
  } catch (error) {
    return error instanceof TsgitError ? error.data : error;
  }
  throw new Error('expected a refusal');
};

describe('parseOrtStrategyOptions', () => {
  describe.each([
    ['no option', [], {}],
    ['no-renames', ['no-renames'], { detect: false }],
    ['find-renames', ['find-renames'], { detect: true }],
    ['find-renames=', ['find-renames='], { detect: true }],
    ['find-renames=0', ['find-renames=0'], { detect: true }],
    ['find-renames=77', ['find-renames=77'], { detect: true, threshold: 46200 }],
    ['rename-threshold=70%', ['rename-threshold=70%'], { detect: true, threshold: 42000 }],
    ['find-renames=90 then find-renames', ['find-renames=90', 'find-renames'], { detect: true }],
    ['find-renames then no-renames', ['find-renames', 'no-renames'], { detect: false }],
    [
      'no-renames then find-renames=90',
      ['no-renames', 'find-renames=90'],
      { detect: true, threshold: 54000 },
    ],
    [
      'find-renames=90 then no-renames',
      ['find-renames=90', 'no-renames'],
      { detect: false, threshold: 54000 },
    ],
  ])('Given %s', (_label, options, expected) => {
    describe('When parsed', () => {
      it('Then the rename settings are git’s', () => {
        // Arrange
        const sut = parseOrtStrategyOptions;

        // Act
        const result = sut(options);

        // Assert
        expect(result).toEqual({ renames: expected });
      });
    });
  });

  describe.each([
    'bogus',
    '',
    'find-renames=abc',
    'find-renames=5x',
    'diff-algorithm=bogus',
    'diff-algorithm:myers',
  ])('Given the option %j', (option) => {
    describe('When parsed', () => {
      it('Then it refuses as an unknown strategy option', () => {
        // Arrange
        const options = ['find-renames', option];

        // Act
        const result = failureOf(options);

        // Assert
        expect(result).toEqual({ code: 'UNKNOWN_STRATEGY_OPTION', option });
      });
    });
  });

  describe.each([
    ['ours', ['ours'], 'ours'],
    ['theirs', ['theirs'], 'theirs'],
    ['ours then theirs', ['ours', 'theirs'], 'theirs'],
    ['theirs then ours', ['theirs', 'ours'], 'ours'],
  ] as const)('Given %s', (_label, options, variant) => {
    describe('When parsed', () => {
      it('Then the last side wins every overlapping hunk', () => {
        // Arrange
        const sut = parseOrtStrategyOptions;

        // Act
        const result = sut(options);

        // Assert
        expect(result).toEqual({ renames: {}, variant });
      });
    });
  });

  describe.each([
    ['ignore-space-change', ['ignore-space-change'], { mode: 'change', ignoreCrAtEol: false }],
    ['ignore-all-space', ['ignore-all-space'], { mode: 'all', ignoreCrAtEol: false }],
    ['ignore-space-at-eol', ['ignore-space-at-eol'], { mode: 'at-eol', ignoreCrAtEol: false }],
    ['ignore-cr-at-eol', ['ignore-cr-at-eol'], { mode: 'none', ignoreCrAtEol: true }],
    [
      'ignore-all-space then ignore-space-at-eol',
      ['ignore-all-space', 'ignore-space-at-eol'],
      { mode: 'all', ignoreCrAtEol: false },
    ],
    [
      'ignore-space-at-eol then ignore-space-change',
      ['ignore-space-at-eol', 'ignore-space-change'],
      { mode: 'change', ignoreCrAtEol: false },
    ],
    [
      'ignore-space-change then ignore-cr-at-eol',
      ['ignore-space-change', 'ignore-cr-at-eol'],
      { mode: 'change', ignoreCrAtEol: true },
    ],
  ] as const)('Given %s', (_label, options, lineKey) => {
    describe('When parsed', () => {
      it('Then the content merge ignores the strongest whitespace class set', () => {
        // Arrange
        const sut = parseOrtStrategyOptions;

        // Act
        const result = sut(options);

        // Assert
        expect(result).toEqual({ renames: {}, lineKey });
      });
    });
  });

  describe.each([
    ['diff-algorithm=Minimal', ['diff-algorithm=Minimal'], { diffAlgorithm: 'minimal' }],
    ['diff-algorithm=myers', ['diff-algorithm=myers'], { diffAlgorithm: 'myers' }],
    [
      'minimal then default',
      ['diff-algorithm=minimal', 'diff-algorithm=default'],
      { diffAlgorithm: 'myers' },
    ],
    ['patience then myers', ['patience', 'diff-algorithm=Myers'], { diffAlgorithm: 'myers' }],
    [
      'histogram then minimal',
      ['histogram', 'diff-algorithm=minimal'],
      { diffAlgorithm: 'minimal' },
    ],
    ['histogram', ['histogram'], { diffAlgorithm: 'histogram' }],
    ['patience', ['patience'], { diffAlgorithm: 'patience' }],
    ['diff-algorithm=Patience', ['diff-algorithm=Patience'], { diffAlgorithm: 'patience' }],
    ['histogram then patience', ['histogram', 'patience'], { diffAlgorithm: 'patience' }],
    ['diff-algorithm=HISTOGRAM', ['diff-algorithm=HISTOGRAM'], { diffAlgorithm: 'histogram' }],
    [
      'minimal then histogram',
      ['diff-algorithm=minimal', 'histogram'],
      { diffAlgorithm: 'histogram' },
    ],
  ] as const)('Given %s', (_label, options, algorithm) => {
    describe('When parsed', () => {
      it('Then the last algorithm named drives the line diffs', () => {
        // Arrange
        const sut = parseOrtStrategyOptions;

        // Act
        const result = sut(options);

        // Assert
        expect(result).toEqual({ renames: {}, ...algorithm });
      });
    });
  });

  describe.each([
    ['subtree', ['subtree'], ''],
    ['subtree=dir', ['subtree=dir'], 'dir'],
    ['subtree=dir then subtree', ['subtree=dir', 'subtree'], ''],
  ] as const)('Given %s', (_label, options, subtreeShift) => {
    describe('When parsed', () => {
      it('Then the other side shifts by the last subtree named', () => {
        // Arrange
        const sut = parseOrtStrategyOptions;

        // Act
        const result = sut(options);

        // Assert
        expect(result).toEqual({ renames: {}, subtreeShift });
      });
    });
  });

  describe.each([
    ['no-renormalize', ['no-renormalize']],
    ['renormalize then no-renormalize', ['renormalize', 'no-renormalize']],
  ])('Given %s', (_label, options) => {
    describe('When parsed', () => {
      it('Then the merge keeps git’s default of no renormalization', () => {
        // Arrange
        const sut = parseOrtStrategyOptions;

        // Act
        const result = sut(options);

        // Assert
        expect(result).toEqual({ renames: {} });
      });
    });
  });

  describe('Given no-renormalize then renormalize', () => {
    describe('When parsed', () => {
      it('Then it refuses the renormalization that stands', () => {
        // Arrange
        const options = ['no-renormalize', 'renormalize'];

        // Act
        const result = failureOf(options);

        // Assert
        expect(result).toEqual({
          code: 'UNSUPPORTED_OPERATION',
          operation: 'merge',
          reason: '-Xrenormalize',
        });
      });
    });
  });

  describe.each(['renormalize'])('Given the option %j', (option) => {
    describe('When parsed', () => {
      it('Then it refuses as not yet supported', () => {
        // Arrange
        const options = [option];

        // Act
        const result = failureOf(options);

        // Assert
        expect(result).toEqual({
          code: 'UNSUPPORTED_OPERATION',
          operation: 'merge',
          reason: `-X${option}`,
        });
      });
    });
  });
});

describe('diffAlgorithmValue', () => {
  describe.each([
    ['myers', 'myers'],
    ['default', 'myers'],
    ['Default', 'myers'],
    ['minimal', 'minimal'],
    ['MINIMAL', 'minimal'],
    ['patience', 'patience'],
    ['PATIENCE', 'patience'],
    ['histogram', 'histogram'],
    ['Histogram', 'histogram'],
  ] as const)('Given the config value %j', (value, expected) => {
    describe('When read as git reads diff.algorithm', () => {
      it(`Then it names ${expected}`, () => {
        // Arrange
        const sut = diffAlgorithmValue;

        // Act
        const result = sut(value);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe.each(['bogus', '', 'myers ', 'diff-algorithm=myers'])(
    'Given the config value %j',
    (value) => {
      describe('When read as git reads diff.algorithm', () => {
        it('Then it names no algorithm', () => {
          // Arrange
          const sut = diffAlgorithmValue;

          // Act
          const result = sut(value);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    },
  );
});
