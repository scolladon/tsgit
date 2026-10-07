import { describe, expect, it } from 'vitest';
import { compileExtendedRegex } from '../../../../src/domain/regex/extended-regex.js';

const LONG_RUN = 40;
const STACKED_OPERATORS = 100_000;
const MAX_GROUP_NESTING = 500;
const EMPTY_GROUPS = 50_000;
const STACKED_INTERVALS = 20_000;
/** Two widest optional runs (two instructions per optional `a`) and four `a`s: 2^17 instructions. */
const FULL_BUDGET = `${'a{0,32767}'.repeat(2)}aaaa`;

const matches = (pattern: string, subject: string): boolean | undefined =>
  compileExtendedRegex(pattern)?.test(subject);

const nested = (depth: number): string => `${'('.repeat(depth)}a${')'.repeat(depth)}`;

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
        ['^a+{2}$', 'a', false],
        ['^a+{2}$', 'aa', true],
        ['^a?{2}$', 'aaa', false],
        ['^a{2}?$', 'a', false],
        ['^a*{0}b$', 'b', true],
        ['^a*{0}b$', 'ab', false],
        ['^a{0}*b$', 'b', true],
        ['^a{0}*b$', 'ab', false],
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
        ['\\<fix', 'fix', true],
        ['fix\\>', 'fix', true],
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
        ['fix bug', 'a fix bug here', true],
        ['fix bug', 'a fix  bug', false],
        ['\uD800', '\u{10000}', false],
        ['\uD800', 'a\uD800', true],
        ['fix.*bug', 'fix the bug', true],
        ['fix.*bug', 'the bug', false],
        ['ab.cde', 'ab_cde', true],
        ['ab.cde', 'ab_cd', false],
        ['(bo)ok', 'a book', true],
        ['(an)+a', 'banana', true],
        ['(ab)+c', 'xac', false],
        ['x(ab)*', 'x', true],
        ['b(an)+', 'banana', true],
        ['^book', 'books', true],
        ['^book', 'a book', false],
        ['abc|x', 'x', true],
        ['(ab|cd)e', 'cde', true],
        ['quick.*zzz', 'quick then zzz', true],
        ['quick.*zzz', 'quick only', false],
        ['^ab', 'xab', false],
        ['^ab', 'abx', true],
        ['^a.c', 'abc', true],
        ['(^a|^b)c', 'xbc', false],
        ['(^a|^b)c', 'bc', true],
        ['(^a|b)c', 'xbc', true],
        ['(^a)+b', 'ab', true],
        ['(^a)*b', 'xb', true],
        ['\\<a.c', 'x abc', true],
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
        ['x{2,1}*'],
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

  describe('Given a pattern a backtracking matcher takes exponential time on', () => {
    describe('When it is matched against a long run it cannot match', () => {
      it.each([
        ['(a+)+b', 'a'],
        ['(a|a)*b', 'a'],
        ['(a*)*b', 'a'],
        ['(x+x+)+y', 'x'],
      ])('Then /%s/ answers false', (pattern, character) => {
        // Arrange
        const sut = matches;

        // Act
        const result = sut(pattern, character.repeat(LONG_RUN));

        // Assert
        expect(result).toBe(false);
      });
    });

    describe('When it is matched against a long run it can match', () => {
      it('Then it answers true', () => {
        // Arrange
        const sut = matches;

        // Act
        const result = sut('(a+)+b', `${'a'.repeat(LONG_RUN)}b`);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given repetition operators stacked by the thousand', () => {
    describe('When the pattern is matched', () => {
      it.each([
        ['a', '*', `${'a'.repeat(3)}b`],
        ['a', '+', `${'a'.repeat(3)}b`],
        ['a', '?', 'ab'],
        ['a{2}', '{1}', 'aab'],
      ])('Then %s stacked with %s repeats like once', (atom, operator, subject) => {
        // Arrange
        const sut = matches;

        // Act
        const result = sut(`^${atom}${operator.repeat(STACKED_OPERATORS)}b$`, subject);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given groups nested as deep as accepted', () => {
    describe('When the pattern is matched', () => {
      it('Then it matches', () => {
        // Arrange
        const sut = matches;

        // Act
        const result = sut(nested(MAX_GROUP_NESTING), 'a');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given groups nested one level deeper than accepted', () => {
    describe('When it is compiled', () => {
      it('Then it yields no matcher', () => {
        // Arrange
        const sut = compileExtendedRegex;

        // Act
        const result = sut(nested(MAX_GROUP_NESTING + 1));

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given repetitions whose expansion exceeds the automaton budget', () => {
    describe('When it is compiled', () => {
      it.each([['(a{1000}){1000}'], ['(a{0,600}){0,600}'], ['a{0,32767}'.repeat(3)]])(
        'Then /%s/ yields no matcher',
        (pattern) => {
          // Arrange
          const sut = compileExtendedRegex;

          // Act
          const result = sut(pattern);

          // Assert
          expect(result).toBeUndefined();
        },
      );
    });
  });

  describe('Given repetitions expanding to exactly the automaton budget', () => {
    describe('When the pattern is matched', () => {
      it('Then it matches', () => {
        // Arrange
        const sut = matches;

        // Act
        const result = sut(FULL_BUDGET, 'aaaaaaaa');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given one repetition expanding to exactly the automaton budget', () => {
    describe('When the pattern is matched', () => {
      it('Then it compiles and answers', () => {
        // Arrange
        const sut = matches;

        // Act
        const result = sut('(a{16}){8192}', 'a');

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given the widest interval stacked by the thousand', () => {
    describe('When it is compiled', () => {
      it('Then it yields no matcher', () => {
        // Arrange
        const sut = compileExtendedRegex;

        // Act
        const result = sut(`a${'{32767}'.repeat(STACKED_INTERVALS)}`);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given repetitions expanding one instruction past the automaton budget', () => {
    describe('When it is compiled', () => {
      it('Then it yields no matcher', () => {
        // Arrange
        const sut = compileExtendedRegex;

        // Act
        const result = sut(`${FULL_BUDGET}a`);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given an empty group repeated past the automaton budget', () => {
    describe('When the pattern is matched', () => {
      it('Then the empty repetition costs nothing and it matches', () => {
        // Arrange
        const sut = matches;

        // Act
        const result = sut('^((){0,32767}){0,32767}a$', 'a');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a repeated group holding thousands of empty groups', () => {
    describe('When the pattern is matched', () => {
      it('Then it matches', () => {
        // Arrange
        const sut = matches;

        // Act
        const result = sut(`(${'()'.repeat(EMPTY_GROUPS)}a){0,32767}`, 'a');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given repetitions whose expansion stays within the automaton budget', () => {
    describe('When it is matched', () => {
      it('Then it matches', () => {
        // Arrange
        const sut = matches;

        // Act
        const result = sut('^(a{0,200}){0,200}$', 'aaaa');

        // Assert
        expect(result).toBe(true);
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
