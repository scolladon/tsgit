import { describe, expect, it } from 'vitest';
import {
  compileExtendedRegex,
  type ExtendedRegex,
} from '../../../../src/domain/regex/extended-regex.js';

/**
 * Wall-clock budget for the message-search matcher against V8's RegExp. This
 * is a PERFORMANCE test, not a unit test: its budget is load-dependent, so it
 * runs in the dedicated `perf` project, outside what Stryker mutates.
 */
const MESSAGES = 2000;
const MESSAGE_LENGTH = 300;
const ROUNDS = 7;
/** How many times slower than RegExp the matcher may run on a pattern holding literal text. */
const RATIO_BUDGET = 3;
const WORDS = 'the quick brown fox jumps over lazy dog refactor merge branch release'.split(' ');

const messages = (): ReadonlyArray<string> =>
  Array.from({ length: MESSAGES }, (_, index) => {
    let message = '';
    for (let word = index; message.length < MESSAGE_LENGTH; word += 7) {
      message += `${WORDS[word % WORDS.length]} `;
    }
    return message;
  });

const medianMs = (test: (subject: string) => boolean, subjects: ReadonlyArray<string>): number => {
  const rounds: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = performance.now();
    for (const subject of subjects) test(subject);
    rounds.push(performance.now() - start);
  }
  return rounds.sort((a, b) => a - b)[ROUNDS >> 1] as number;
};

describe('compileExtendedRegex (performance)', () => {
  describe.each(['fix the bug', 'quick.*zzz', '^release zzz'])('Given /%s/', (pattern) => {
    describe('When it scans commit messages', () => {
      it('Then it stays within a small factor of RegExp', () => {
        // Arrange
        const sut = compileExtendedRegex;
        const native = new RegExp(pattern, 'su');
        const subjects = messages();

        // Act
        const matcher = sut(pattern) as ExtendedRegex;
        const ere = medianMs((subject) => matcher.test(subject), subjects);
        const regexp = medianMs((subject) => native.test(subject), subjects);

        // Assert
        expect(ere).toBeLessThan(regexp * RATIO_BUDGET + 1);
      });
    });
  });
});
