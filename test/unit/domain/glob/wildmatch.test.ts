import { describe, expect, it } from 'vitest';
import {
  matchWildmatch,
  tokenizeWildmatch,
  type WildmatchFlags,
} from '../../../../src/domain/glob/wildmatch.js';
import { encode } from '../../../../src/domain/objects/encoding.js';

const wildmatch = (pattern: string, text: string, flags: WildmatchFlags): boolean => {
  const tokens = tokenizeWildmatch(encode(pattern), flags);
  if (tokens === undefined) return false;
  return matchWildmatch(tokens, encode(text));
};

const FLAGS_0: WildmatchFlags = { pathname: false };
const PATHNAME: WildmatchFlags = { pathname: true };

describe('wildmatch', () => {
  describe('Given the flags-0 dialect', () => {
    describe('When matching', () => {
      it.each([
        ['a*b', 'a/x/b', true],
        ['?', '/', true],
        ['\\*', '*', true],
        ['\\*', 'x', false],
        ['[a-c]', 'b', true],
        ['[a-c]', 'd', false],
      ])('Then %j against %j gives %s', (pattern, text, expected) => {
        // Arrange
        const sut = wildmatch;

        // Act
        const result = sut(pattern, text, FLAGS_0);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given the WM_PATHNAME dialect', () => {
    describe('When matching', () => {
      it.each([
        ['a*b', 'a/x/b', false],
        ['?', '/', false],
        ['**/b', 'b', true],
        ['**/b', 'x/y/b', true],
        ['**\\/b', 'b', false],
        ['**\\/b', 'x/b', true],
        ['\\*', '*', true],
        ['\\*', 'x', false],
        ['[a-c]', 'b', true],
        ['[a-c]', 'd', false],
      ])('Then %j against %j gives %s', (pattern, text, expected) => {
        // Arrange
        const sut = wildmatch;

        // Act
        const result = sut(pattern, text, PATHNAME);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given a pattern git would abort on', () => {
    describe('When tokenizing', () => {
      it.each(['a\\', '[a', '[[:foo:]]', '[[:digit:]'])('Then %j yields no tokens', (pattern) => {
        // Arrange
        const sut = tokenizeWildmatch;

        // Act
        const result = sut(encode(pattern), FLAGS_0);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});
