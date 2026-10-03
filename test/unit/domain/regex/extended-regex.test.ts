import { describe, expect, it } from 'vitest';
import { compileExtendedRegex } from '../../../../src/domain/regex/extended-regex.js';

const matches = (pattern: string, subject: string): boolean | undefined =>
  compileExtendedRegex(pattern)?.test(subject);

describe('compileExtendedRegex', () => {
  describe('Given a pattern regcomp(REG_EXTENDED) accepts', () => {
    describe('When it is matched against a subject', () => {
      it.each([
        ['fix', 'first fix\n', true],
        ['fix', 'first\n', false],
        ['s.c', 'second', true],
        ['a.b', 'a\nb', true],
        ['^first', 'first fix', true],
        ['^fix', 'first fix', false],
        ['^fix', 'first\nfix', false],
        ['date$', 'same-date\n', false],
        ['date$', 'same-date', true],
        ['s(ec|id)e', 'side', true],
        ['s(ec|id)e', 'sake', false],
        ['a+?', 'zzz', true],
        ['ba+?c', 'bc', true],
        ['a**', 'b', true],
        ['ab*?c', 'ac', true],
        ['x{2}', 'x', false],
        ['x{2}', 'xx', true],
        ['^x{,2}$', 'xx', true],
        ['^x{,2}$', 'xxx', false],
        ['^x{2,}$', 'xxx', true],
        ['^x{1,2}$', 'xxx', false],
        ['^x{,}$', '', true],
        ['x{0}y', 'y', true],
        ['a{1}{2}', 'aa', true],
        ['[[:digit:]]', 'v2', true],
        ['[[:digit:]]', 'vv', false],
        ['^[[:alpha:]]+$', 'abc', true],
        ['^[[:alnum:]_]+$', 'a_1', true],
        ['[[:upper:]]', 'abc', false],
        ['[[:lower:]]', 'ABc', true],
        ['[[:space:]]', 'a\tb', true],
        ['[[:blank:]]', 'a\nb', false],
        ['[[:punct:]]', 'a!', true],
        ['[[:xdigit:]]', 'g', false],
        ['[[:xdigit:]]', 'F', true],
        ['[[:cntrl:]]', 'a\u0001', true],
        ['[[:graph:]]', ' ', false],
        ['[[:print:]]', ' ', true],
        ['[]x]', ']', true],
        ['[^]x]', ']', false],
        ['[^]x]', 'y', true],
        ['[a\\]', '\\', true],
        ['[a\\]', 'n', false],
        ['[a-c]', 'b', true],
        ['[a-c]', 'd', false],
        ['[-a]', '-', true],
        ['[a-]', '-', true],
        ['[[.a.]-c]', 'b', true],
        ['[[=e=]]', 'e', true],
        ['[^a]', '\n', true],
        ['[x[]', '[', true],
        ['\\<fix', 'prefix fix', true],
        ['\\<fix', 'prefix', false],
        ['fix\\>', 'fixed', false],
        ['fix\\>', 'a fix.', true],
        ['\\bfix\\b', 'a fix', true],
        ['\\Bfix', 'prefix', true],
        ['\\Bfix', 'a fix', false],
        ['\\w+', '!!', false],
        ['\\W', 'ab', false],
        ['\\s', 'a b', true],
        ['\\S', ' ', false],
        ['\\`a', 'ba', false],
        ["a\\'", 'ab', false],
        ["a\\'", 'ba', true],
        ['(a)\\1', 'aa', true],
        ['(a)\\1', 'ab', false],
        ['(a)\\10', 'aa0', true],
        ['\\.', 'a', false],
        ['\\{', '{', true],
        ['\\n', 'n', true],
        ['a)', 'a)', true],
        ['a}', 'a}', true],
        ['()', 'x', true],
        ['a|', 'x', true],
        ['/x', 'a/x', true],
        ['caf.', 'café', true],
        ['^.$', '😀', true],
      ])('Then /%s/ against %j answers %s', (pattern, subject, expected) => {
        // Arrange
        const sut = compileExtendedRegex;

        // Act
        const result = sut(pattern)?.test(subject);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given a pattern regcomp(REG_EXTENDED) refuses', () => {
    describe('When it is compiled', () => {
      it.each([
        ['*x'],
        ['+x'],
        ['?x'],
        ['{1}x'],
        ['(*x)'],
        ['a|*b'],
        ['^*'],
        ['a$+'],
        ['\\<*'],
        ['(x'],
        ['x\\'],
        ['x{'],
        ['x{}'],
        ['x{1'],
        ['x{a}'],
        ['x{1,a}'],
        ['x{2,1}'],
        ['x{32768}'],
        ['x{32768,}'],
        ['x{1,2,3}'],
        ['['],
        ['[a'],
        ['[]'],
        ['[^]'],
        ['[[:nope:]]'],
        ['[[:alpha:]'],
        ['[[:alpha]'],
        ['[[.ab.]]'],
        ['[[=ab=]]'],
        ['[[.a'],
        ['[c-a]'],
        ['[a-'],
        ['[a-c-e]'],
        ['[[:alpha:]-z]'],
        ['[a-[:alpha:]]'],
        ['[[=a=]-z]'],
        ['\\1'],
        ['(a\\1)'],
      ])('Then /%s/ yields no matcher', (pattern) => {
        // Arrange
        const sut = compileExtendedRegex;

        // Act
        const result = sut(pattern);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given the largest interval regcomp accepts', () => {
    describe('When it is compiled', () => {
      it('Then it matches', () => {
        // Arrange
        const sut = matches;

        // Act
        const result = sut('^x{0,32767}$', 'xx');

        // Assert
        expect(result).toBe(true);
      });
    });
  });
});
