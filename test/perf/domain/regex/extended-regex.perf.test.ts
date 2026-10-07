import { describe, expect, it } from 'vitest';
import {
  compileExtendedRegex,
  type ExtendedRegex,
} from '../../../../src/domain/regex/extended-regex.js';

/**
 * Wall-clock budget for the message-search matcher against V8's RegExp. This
 * is a PERFORMANCE test, not a unit test: its budget is load-dependent, so it
 * runs in the dedicated `perf` project, outside what Stryker mutates. Both
 * matchers warm up, then run in alternating rounds; the budget bounds the
 * median of the per-round ratios, so a load spike skews one round, not all.
 */
const MESSAGES = 2000;
const MESSAGE_LENGTH = 100;
const ROUNDS = 9;
const WARM_UP_PASSES = 3;
/** Shortest round RegExp may take, so timer resolution never sets the ratio. */
const MIN_ROUND_MS = 10;
/** How many times slower than RegExp a substring search may run. */
const SUBSTRING_BUDGET = 3;
/** How many times slower than RegExp the automaton may run where it reads every message. */
const AUTOMATON_BUDGET = 16;
/** How many times slower than RegExp an anchored pattern may run: RegExp gives up at once. */
const ANCHORED_BUDGET = 8;
const WORDS = [
  'the',
  'quick',
  'brown',
  'fox',
  'jumps',
  'over',
  'lazy',
  'dog',
  'refactor',
  'merge',
  'branch',
  'release',
  'feat:',
  'fix:',
  'v2.1',
  '#1042',
];

type Matcher = (subject: string) => boolean;

const messages = (): ReadonlyArray<string> =>
  Array.from({ length: MESSAGES }, (_, index) => {
    let message = '';
    for (let word = index; message.length < MESSAGE_LENGTH; word += 7) {
      message += `${WORDS[word % WORDS.length]} `;
    }
    return message;
  });

const roundMs = (test: Matcher, subjects: ReadonlyArray<string>, passes: number): number => {
  const start = performance.now();
  for (let pass = 0; pass < passes; pass += 1) {
    for (const subject of subjects) test(subject);
  }
  return performance.now() - start;
};

/** Passes over the subjects that take RegExp at least the shortest round. */
const passesFor = (native: Matcher, subjects: ReadonlyArray<string>): number =>
  Math.ceil(MIN_ROUND_MS / Math.max(roundMs(native, subjects, 1), Number.EPSILON));

const medianRatio = (ere: Matcher, native: Matcher, subjects: ReadonlyArray<string>): number => {
  roundMs(ere, subjects, WARM_UP_PASSES);
  roundMs(native, subjects, WARM_UP_PASSES);
  const passes = passesFor(native, subjects);
  const ratios: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const ereMs = roundMs(ere, subjects, passes);
    ratios.push(ereMs / roundMs(native, subjects, passes));
  }
  return ratios.sort((a, b) => a - b)[ROUNDS >> 1] as number;
};

describe('compileExtendedRegex (performance)', () => {
  describe.each([
    ['fix the bug', SUBSTRING_BUDGET],
    ['quick.*zzz', SUBSTRING_BUDGET],
    ['^release zzz', ANCHORED_BUDGET],
    ['[0-9]{4}', AUTOMATON_BUDGET],
    ['a|b', SUBSTRING_BUDGET],
    ['feat|fix', SUBSTRING_BUDGET],
    ['(feat|fix):', SUBSTRING_BUDGET],
  ])('Given /%s/', (pattern, budget) => {
    describe('When it scans commit messages', () => {
      it(`Then it runs within ${budget} times RegExp`, () => {
        // Arrange
        const sut = compileExtendedRegex;
        const native = new RegExp(pattern, 'su');
        const subjects = messages();

        // Act
        const matcher = sut(pattern) as ExtendedRegex;
        const result = medianRatio(
          (subject) => matcher.test(subject),
          (subject) => native.test(subject),
          subjects,
        );

        // Assert
        expect(result).toBeLessThan(budget);
      });
    });
  });
});
