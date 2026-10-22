import { describe, expect, it } from 'vitest';
import {
  compileWildcard,
  hasGlobSpecial,
  MATCH_LEVEL,
  oneStarMatches,
  verbatimLevel,
  wildcardShape,
} from '../../../../src/domain/pathspec/wildcard.js';

describe('verbatimLevel', () => {
  describe.each([
    { body: 'src', path: 'src', expected: MATCH_LEVEL.EXACT },
    { body: 'src', path: 'src/a', expected: MATCH_LEVEL.RECURSIVE },
    { body: 'src', path: 'src2', expected: MATCH_LEVEL.NONE },
    { body: 'd/', path: 'd/x', expected: MATCH_LEVEL.RECURSIVE },
    { body: 'a?', path: 'a?/f', expected: MATCH_LEVEL.RECURSIVE },
    { body: '', path: 'x', expected: MATCH_LEVEL.RECURSIVE },
    { body: 'src/a', path: 'src', expected: MATCH_LEVEL.NONE },
  ])('Given the body "$body" and the path "$path"', ({ body, path, expected }) => {
    describe('When computing the verbatim level', () => {
      it('Then it is the expected level', () => {
        // Arrange
        const sut = verbatimLevel;
        // Act
        const result = sut(body, path);
        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('hasGlobSpecial', () => {
  describe.each([
    { body: '*.ts', expected: true },
    { body: 'a?', expected: true },
    { body: '[ab]', expected: true },
    { body: 'a\\b', expected: true },
    { body: 'plain.ts', expected: false },
    { body: 'a]b', expected: false },
    { body: '', expected: false },
  ])('Given the body "$body"', ({ body, expected }) => {
    describe('When testing for glob specials', () => {
      it('Then the verdict is the expected one', () => {
        // Arrange
        const sut = hasGlobSpecial;
        // Act
        const result = sut(body);
        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('compileWildcard', () => {
  describe.each([
    { body: 'src/*.ts', path: 'src/a/b.ts', expected: true },
    { body: 'src/*.ts', path: 'src/x.ts', expected: true },
    { body: 'src/*.ts', path: 'y.ts', expected: false },
    { body: 'foo*', path: 'foo1', expected: true },
    { body: 'foo*', path: 'dir/foobar', expected: false },
    { body: '[a-c].txt', path: 'a.txt', expected: true },
    { body: '[a-c].txt', path: 'd.txt', expected: false },
    { body: '[!a].txt', path: 'b.txt', expected: true },
    { body: '[!a].txt', path: 'a.txt', expected: false },
    { body: '[^a].txt', path: 'b.txt', expected: true },
    { body: '[^a].txt', path: 'a.txt', expected: false },
    { body: '[[:digit:]].txt', path: '1.txt', expected: true },
    { body: '[/a]*', path: 'a/b', expected: true },
    { body: '[/a]*', path: 'x', expected: false },
    { body: 'a\\*b', path: 'a*b', expected: true },
    { body: 'a\\*b', path: 'aXb', expected: false },
    { body: 'a\\?b', path: 'a?b', expected: true },
    { body: 'a\\?b', path: 'axb', expected: false },
    { body: 'a\\b', path: 'a\\b', expected: true },
    { body: 'a\\b', path: 'ab', expected: true },
    { body: 'a?', path: 'a?/f', expected: true },
    { body: 'a?', path: 'ab', expected: true },
    { body: 'di?', path: 'dir/file', expected: false },
    { body: '**/x.txt', path: 'd/x.txt', expected: true },
    { body: '**/x.txt', path: 'x.txt', expected: false },
    { body: '[]a]', path: ']', expected: true },
    { body: '[]a]', path: 'a', expected: true },
    { body: '[]a]', path: 'b', expected: false },
    { body: '?.txt', path: 'é.txt', expected: false },
    { body: '??.txt', path: 'é.txt', expected: true },
    { body: 'd*/', path: 'dir/f', expected: false },
    { body: 'a[', path: 'a[', expected: true },
    { body: 'a[', path: 'ab', expected: false },
  ])('Given the body "$body" and the path "$path"', ({ body, path, expected }) => {
    describe('When testing the path', () => {
      it('Then the verdict is the expected one', () => {
        // Arrange
        const sut = compileWildcard;
        // Act
        const result = sut(body).test(path);
        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe.each([
    { body: 'a?', expected: [true, false, true] },
    { body: 'a??', expected: [false, true, false] },
    { body: 'a[^b]', expected: [true, false, false] },
    { body: 'a[[:alpha:]]', expected: [false, false, true] },
    { body: 'a*', expected: [true, true, true] },
  ])('Given the body "$body" and paths holding a non-UTF-8 byte', ({ body, expected }) => {
    describe('When testing the escape-view paths', () => {
      it('Then each verdict reads the raw bytes', () => {
        // Arrange
        const sut = compileWildcard;
        const paths = ['a\udcff', 'aé', 'ab'];
        // Act
        const matcher = sut(body);
        const result = paths.map((path) => matcher.test(path));
        // Assert
        expect(result).toEqual(expected);
      });
    });
  });
});

describe('wildcardShape', () => {
  describe.each([
    { body: '*.ts', expected: { kind: 'one-star', prefix: '', suffix: '.ts' } },
    { body: 'src/*.ts', expected: { kind: 'one-star', prefix: 'src/', suffix: '.ts' } },
    { body: 'foo*', expected: { kind: 'one-star', prefix: 'foo', suffix: '' } },
    { body: 'a*b*', expected: { kind: 'general', literalPrefix: 'a' } },
    { body: 'src/[ab]*', expected: { kind: 'general', literalPrefix: 'src/' } },
    { body: 'a\\*', expected: { kind: 'general', literalPrefix: 'a' } },
    { body: 'a?*', expected: { kind: 'general', literalPrefix: 'a' } },
    { body: 'plain.ts', expected: { kind: 'general', literalPrefix: 'plain.ts' } },
  ])('Given the body "$body"', ({ body, expected }) => {
    describe('When classifying its shape', () => {
      it('Then it is the expected shape', () => {
        // Arrange
        const sut = wildcardShape;
        // Act
        const result = sut(body);
        // Assert
        expect(result).toEqual(expected);
      });
    });
  });
});

describe('oneStarMatches', () => {
  describe.each([
    { prefix: '', suffix: '.ts', path: '.ts', expected: true },
    { prefix: 'a', suffix: 'a', path: 'a', expected: false },
    { prefix: 'src/', suffix: '.ts', path: 'src/a/b.ts', expected: true },
    { prefix: 'src/', suffix: '.ts', path: 'lib/x.ts', expected: false },
    { prefix: 'a', suffix: '', path: 'a\udcff', expected: true },
    { prefix: 'a', suffix: 'b', path: 'ac', expected: false },
  ])('Given prefix "$prefix", suffix "$suffix" and the path "$path"', (row) => {
    describe('When matching', () => {
      it('Then the verdict is the expected one', () => {
        // Arrange
        const sut = oneStarMatches;
        // Act
        const result = sut(row.prefix, row.suffix, row.path);
        // Assert
        expect(result).toBe(row.expected);
      });
    });
  });
});
