import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileExtendedRegex } from '../../../../src/domain/regex/extended-regex.js';

const LONG_RUN = 40;
const STACKED_OPERATORS = 100_000;
const MAX_GROUP_NESTING = 500;
const EMPTY_GROUPS = 50_000;
const STACKED_INTERVALS = 20_000;
/** The automaton's instruction budget. */
const MAX_PROGRAM_SIZE = 1 << 17;
/** Widest intervals each within the budget alone, together far past it. */
const WIDE_INTERVALS = 10;
/** A subject the automaton steps through for well over a check interval. */
const LONG_SUBJECT_LENGTH = 1 << 18;
const STOP = new Error('stop');

const stop = (): never => {
  throw STOP;
};
/** Two widest optional runs (two instructions per optional `a`) and four `a`s: 2^17 instructions. */
const FULL_BUDGET = `${'a{0,32767}'.repeat(2)}aaaa`;

const matches = (pattern: string, subject: string): boolean | undefined =>
  compileExtendedRegex(pattern)?.test(subject);

const nested = (depth: number): string => `${'('.repeat(depth)}a${')'.repeat(depth)}`;

describe('compileExtendedRegex', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
        ['\\<a', '\u{1D400}a', false],
        ['\\<a', '\u{1F600}a', true],
        ['\\>', '\u{1D400}', true],
        ['^..$', '\u{1F600}', false],
        ['^é+$', 'éé', true],
        ['^a+$', 'aé', false],
        ['[0-9]{4}', 'v1.2345', true],
        ['[0-9]{4}', 'v1.234 5', false],
        ['x[[:alpha:]]', 'xé', true],
        ['(é|a)b', 'éb', true],
        ['(é|a)b', 'éc', false],
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
      ])('Then /%s/ answers false without backtracking', (pattern, character) => {
        // Arrange
        const sut = compileExtendedRegex;

        // Act
        const result = sut(pattern);

        // Assert
        expect(result?.engine).toBe('linear');
        expect(result?.test(character.repeat(LONG_RUN))).toBe(false);
      });
    });

    describe('When it is matched against a long run it can match', () => {
      it('Then it answers true without backtracking', () => {
        // Arrange
        const sut = compileExtendedRegex;

        // Act
        const result = sut('(a+)+b');

        // Assert
        expect(result?.engine).toBe('linear');
        expect(result?.test(`${'a'.repeat(LONG_RUN)}b`)).toBe(true);
      });
    });
  });

  describe('Given a pattern holding a back-reference', () => {
    describe('When it is compiled', () => {
      it('Then it runs on the backtracking engine', () => {
        // Arrange
        const sut = compileExtendedRegex;

        // Act
        const result = sut('(a)\\1')?.engine;

        // Assert
        expect(result).toBe('backtracking');
      });
    });
  });

  describe('Given a check that throws', () => {
    describe('When the automaton steps through a long subject', () => {
      it('Then the throw stops the match', () => {
        // Arrange
        const sut = compileExtendedRegex;

        // Act
        let result: unknown;
        try {
          sut('a.*b')?.test(`${'a'.repeat(LONG_SUBJECT_LENGTH)}b`, stop);
        } catch (error) {
          result = error;
        }

        // Assert
        expect(result).toBe(STOP);
      });
    });

    describe('When the automaton steps through a short subject', () => {
      it('Then the match ends before the check is consulted', () => {
        // Arrange
        const sut = compileExtendedRegex;

        // Act
        const result = sut('a.*b')?.test('a b', stop);

        // Assert
        expect(result).toBe(true);
      });
    });

    describe('When no character of a long subject can begin a match', () => {
      it('Then the automaton jumps past them without stepping', () => {
        // Arrange
        const sut = compileExtendedRegex;

        // Act
        const result = sut('[0-9]{4}')?.test('x'.repeat(LONG_SUBJECT_LENGTH), stop);

        // Assert
        expect(result).toBe(false);
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

  describe('Given widest intervals each within the automaton budget but together past it', () => {
    describe('When it is compiled', () => {
      it('Then it refuses before laying out copies past the budget', () => {
        // Arrange
        const sut = compileExtendedRegex;
        const fill = vi.spyOn(Array.prototype, 'fill');

        // Act
        const result = sut('a{32767}'.repeat(WIDE_INTERVALS));

        // Assert
        const laidOut = fill.mock.contexts.reduce<number>(
          (total, copies) => total + (copies as unknown[]).length,
          0,
        );
        expect(result).toBeUndefined();
        expect(laidOut).toBeLessThanOrEqual(MAX_PROGRAM_SIZE);
      });
    });
  });

  describe('Given copies past the automaton budget that a later {0} discards', () => {
    describe('When it is compiled', () => {
      it('Then the discarded copies still count and it yields no matcher', () => {
        // Arrange
        const sut = compileExtendedRegex;

        // Act
        const result = sut('((a{32767}){4}){0}'.repeat(2));

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given empty groups repeated past the automaton budget many times over', () => {
    describe('When the pattern is matched', () => {
      it('Then the empty repetitions lay out nothing and it matches', () => {
        // Arrange
        const sut = matches;

        // Act
        const result = sut(`${'(){0,32767}'.repeat(WIDE_INTERVALS)}a`, 'a');

        // Assert
        expect(result).toBe(true);
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
