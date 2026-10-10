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
/** Steps the backtracking matcher takes on any subject before it answers no match. */
const MAX_BACKTRACK_STEPS = 1 << 22;
/** Further steps it may take per code unit of the subject. */
const STEPS_PER_CODE_UNIT = 1 << 6;
/** Choices and undo records it holds before it answers no match. */
const MAX_PATH_ENTRIES = 1 << 22;
/** Copies of `(a|b)` reading `a` whose records reach that bound: each leaves eight, in seven steps. */
const COPIES_AT_BOUND = MAX_PATH_ENTRIES / 8;
/** Steps between two checks. */
const CHECK_INTERVAL = 1 << 16;
/** Steps those copies take to leave that many records: eight in seven steps each. */
const STEPS_TO_PATH_BOUND = (MAX_PATH_ENTRIES / 8) * 7;
/** A subject length whose step limit is a whole number of check intervals. */
const INTERVAL_ALIGNED_LENGTH = CHECK_INTERVAL / STEPS_PER_CODE_UNIT;
/** Steps `(x)a*\\1` takes, beside the run its span reads, up to the back-reference: two saves, `x`, the span and the reference. */
const SPAN_PATTERN_STEPS = 5;
/** Threads a position of `^a*$` steps: its one ready thread and itself. */
const STEPPED_PER_POSITION = 2;
/** Most texts a pattern may spell and still run as a substring search. */
const MAX_EXACT_TEXTS = 16;
/** Two widest intervals that `{0}` discards lay out 2 × 65533 instructions; a run of seven lays out six more. */
const BUDGET_RUN = 7;
/** Words of a message a back-reference pattern splits every way. */
const PROSE = 'every brown fox jumps over a lazy dog and runs into the deep forest ';
const LONG_MESSAGE_LENGTH = 1 << 19;
/** A run the back-reference pattern below splits every way before refusing it. */
const EXPONENTIAL_SUBJECT = `${'a'.repeat(LONG_RUN)}bc`;
/** A run several check intervals long. */
const LONG_RUN_LENGTH = CHECK_INTERVAL * 8;
/** Text repeated by a back-reference, and how many times. */
const REPEATED_TEXT_LENGTH = 1 << 7;
const REPETITIONS = 1 << 6;
/** The groups a back-reference can name. */
const NAMEABLE_GROUPS = 9;
/** GNU's `RE_DUP_MAX`. */
const MAX_REPEAT = 0x7fff;

const stop = (): never => {
  throw STOP;
};
/** Two widest optional runs (two instructions per optional `a`) and four `a`s: 2^17 instructions. */
const FULL_BUDGET = `${'a{0,32767}'.repeat(2)}aaaa`;

const matches = (pattern: string, subject: string): boolean | undefined =>
  compileExtendedRegex(pattern)?.test(subject);

const BACKREFERENCE = '\\1';

/** Lets RegExp tests run but those of a back-reference pattern; the sources of those asked to run. */
const refuseBacktracking = (): ReadonlyArray<string> => {
  const run = RegExp.prototype.test;
  const backtracked: string[] = [];
  vi.spyOn(RegExp.prototype, 'test').mockImplementation(function (this: RegExp, subject: string) {
    if (!this.source.includes(BACKREFERENCE)) return run.call(this, subject);
    backtracked.push(this.source);
    return false;
  });
  return backtracked;
};

const PAST_CEILING = new Error('consulted past the ceiling');

/** A check that counts how often it is consulted, and throws once consulted more than `ceiling` times. */
const countingCheck = (
  ceiling: number,
): { readonly check: () => void; readonly calls: () => number } => {
  let calls = 0;
  return {
    check: () => {
      calls += 1;
      if (calls > ceiling) throw PAST_CEILING;
    },
    calls: () => calls,
  };
};

/** How often the backtracking matcher consults the check on `subject` before its steps are spent. */
const budgetChecks = (subject: string): number =>
  Math.ceil((MAX_BACKTRACK_STEPS + STEPS_PER_CODE_UNIT * subject.length) / CHECK_INTERVAL);

const nested = (depth: number): string => `${'('.repeat(depth)}a${')'.repeat(depth)}`;

/** Most texts the subject is searched for before the automaton runs. */
const MAX_PREFILTER_TEXTS = 32;
/** Most classes a match may begin with for the automaton to jump to where one begins. */
const MAX_LEADING_CLASSES = 8;

/** `t0.t1.…`: a pattern requiring `count` texts, and a text holding them all yet no match. */
const requiringTexts = (count: number): { readonly pattern: string; readonly text: string } => {
  const texts = Array.from({ length: count }, (_, index) => `t${index}`);
  return { pattern: texts.join('.'), text: texts.join('__') };
};

/** `a|b|…` over `count` letters: a pattern spelling `count` texts. */
const letterBranches = (count: number): string =>
  Array.from('abcdefghijklmnopq'.slice(0, count)).join('|');

/** `(c1|c2|…)[0-9]` over `count` letters: a match begins with any of `count` classes. */
const leadingLetters = (count: number): string =>
  `(${Array.from('abcdefghijklmnop'.slice(0, count)).join('|')})[0-9]`;

/** The texts a run searches the subject for. */
const searchedTexts = (): (() => ReadonlyArray<string>) => {
  const includes = vi.spyOn(String.prototype, 'includes');
  return () => includes.mock.calls.map(([text]) => text);
};

/** How often a run jumps ahead with a pattern searching for where a match begins. */
const leadingSearches = (): (() => number) => {
  const test = vi.spyOn(RegExp.prototype, 'test');
  return () => test.mock.contexts.filter((pattern) => (pattern as RegExp).global).length;
};

/** The class a run reads to tell whether a code point is a word character. */
const WORD_CLASS_SOURCE = '[\\p{L}\\p{N}_]';

/** How often a matcher, from its compilation on, asks whether a code point is a word character. */
const wordReads = (): (() => number) => {
  const test = vi.spyOn(RegExp.prototype, 'test');
  return () =>
    test.mock.contexts.filter((pattern) => (pattern as RegExp).source === WORD_CLASS_SOURCE).length;
};

describe('compileExtendedRegex', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Given a pattern whose only assertions read the subject bounds', () => {
    describe('When it is compiled and matched against a subject of word characters', () => {
      it.each([['^(.).*\\1$'], ['^feat'], ['^Merge'], ['fix$']])(
        'Then %s never reads whether a code point is a word character',
        (pattern) => {
          // Arrange
          const reads = wordReads();
          const sut = compileExtendedRegex;

          // Act
          sut(pattern)?.test('é Merge feat fix é');

          // Assert
          expect(reads()).toBe(0);
        },
      );
    });
  });

  describe('Given a pattern asserting a word boundary', () => {
    describe('When it is compiled and matched against a subject of word characters', () => {
      it('Then it reads whether code points are word characters', () => {
        // Arrange
        const reads = wordReads();
        const sut = compileExtendedRegex;

        // Act
        const result = sut('\\bfix\\b')?.test('é prefix fix é');

        // Assert
        expect(result).toBe(true);
        expect(reads()).toBeGreaterThan(0);
      });
    });
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
        ['(ab)\\1', 'xabab', true],
        ['(ab)\\1', 'abba', false],
        ['^((a)|b?){1,2}c\\2', 'ac', false],
        ['^((a)|b){2}\\2', 'ab', false],
        ['^((a)|b){2}\\2', 'aba', true],
        ['^(a){0}\\1b', 'b', false],
        ['(x)?y\\1', 'y', false],
        ['(x)?y\\1', 'xyx', true],
        ['(a)*x\\1', 'x', false],
        ['((a)|b)+x\\2', 'abx', false],
        ['((a)|b)+-\\2', 'ab-a', true],
        ['^(a|())+\\2b$', 'ab', true],
        ['^(a|())*\\2b$', 'b', true],
        ['^(b?)*\\1c$', 'bc', true],
        ['^(a?)*x\\1$', 'x', true],
        ['^(b|()){0,3}\\2c$', 'bbc', true],
        ['^(a?)+\\1b$', 'aab', true],
        ['^.*(.)\\1$', 'x\u{1F600}\u{1F600}', true],
        ['^.*(.)\\1$', '\u{1F600}\uDE00', false],
        ['^(.)é*\\1$', '-éé-', true],
        ['^(1)[12]*2\\1', '12221', true],
        ['^(1)[12]*2\\1', '1111', false],
        ['(a+)+b\\1c', 'aabac', true],
        ['\\<(\\w)\\1', 'a bb', true],
        ['^(a*)\\1$', 'aaaa', true],
        ['^(a*)\\1$', 'aaa', false],
        ['(.)\\1', 'xyy', true],
        ['(.)\\1', 'xyx', false],
        ['(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)\\9', 'abcdefghiji', true],
        ['(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)\\9', 'abcdefghijx', false],
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
        ['feat|fix', 'a fix', true],
        ['feat|fix', 'a fax', false],
        ['(feat|fix):', 'fix: x', true],
        ['(feat|fix):', 'fix x: feat', false],
        ['(1|2)(1|2)(1|2)(1|2)', '0 2112', true],
        ['(1|2)(1|2)(1|2)(1|2)(1|2)', '0 2112', false],
        ['(1|2)(1|2)(1|2)(1|2)(1|2)', '12112', true],
        ['a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q', 'q', true],
        ['a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q', 'z', false],
        ['(12|34)+5', '34125', true],
        ['(12|34)+5', '34 5 12', false],
        ['x(ab|c*)y', 'xy', true],
        ['(a(b|c)|d)e', 'de', true],
        ['(a(b|c)|d)e', 'ace', true],
        ['(a(b|c)|d)e', 'abx', false],
        ['(fe|fi)[a-z]:', 'fix:', true],
        ['(fe|fi)[a-z]:', 'fox:', false],
        ['\uD800|b', '\u{10000}', false],
        ['a)', 'a', false],
        ['^a{2,}?$', 'a', false],
        ['^a{1,2}b$', 'ab', true],
        ['x{32767,}', 'x', false],
        ['[a.]', '.', true],
        ['[a-a]', 'a', true],
        ['^\u0080$', '\u0080', true],
        ['^.$', '\u{10000}', true],
        ['^(.)\\1$', '\u{10000}\u{10000}', true],
        ['(.)\\1', '\u{1F600}\uDE00', false],
        ['(.)\\1', '\u{10000}\uDC00', false],
        ['^(\uDC00)x\u{10000}*\\1$', '\uDC00x\u{10000}', false],
        ['^(a)b*\\1b$', 'ab', false],
        ['^(b)a*\\1$', 'ba-b', false],
        ['^(()b?)*\\2c$', 'c', true],
        ['^(()b?){2}*\\2c$', 'c', true],
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
        ['[[.a.b.]]'],
        ['[[.xy].]]'],
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

  describe('Given a back-reference pattern a backtracking matcher takes exponential time on', () => {
    describe('When a long run cannot match even reading the reference as any text', () => {
      it.each([
        ['(x*)*y\\1', 'x'.repeat(LONG_RUN)],
        ['(x+x+)+y\\1z', `${'x'.repeat(LONG_RUN)}zy`],
      ])('Then /%s/ answers false without backtracking', (pattern, subject) => {
        // Arrange
        const sut = matches;
        const backtracked = refuseBacktracking();

        // Act
        const result = sut(pattern, subject);

        // Assert
        expect(result).toBe(false);
        expect(backtracked).toEqual([]);
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

  describe('Given a back-reference pattern backtracking splits a long run every way on', () => {
    describe('When the run passes the linear check but cannot match', () => {
      it('Then it answers false once the step budget is spent', () => {
        // Arrange
        const sut = compileExtendedRegex;
        const backtracked = refuseBacktracking();
        const { check, calls } = countingCheck(budgetChecks(EXPONENTIAL_SUBJECT) + 1);

        // Act
        const result = sut('(a+)+b\\1c')?.test(EXPONENTIAL_SUBJECT, check);

        // Assert
        expect(result).toBe(false);
        expect(calls()).toBe(budgetChecks(EXPONENTIAL_SUBJECT));
        expect(backtracked).toEqual([]);
      });
    });

    describe('When the subject allows a whole number of check intervals', () => {
      it('Then it answers false at the consult its steps reach the limit on', () => {
        // Arrange
        const sut = compileExtendedRegex;
        const text = `${'a'.repeat(INTERVAL_ALIGNED_LENGTH - 2)}bc`;
        const { check, calls } = countingCheck(budgetChecks(text) + 1);

        // Act
        const result = sut('(a+)+b\\1c')?.test(text, check);

        // Assert
        expect(result).toBe(false);
        expect(calls()).toBe(budgetChecks(text));
      });
    });

    describe('When a match lies past the step budget', () => {
      it('Then it answers false', () => {
        // Arrange
        const sut = compileExtendedRegex;
        const backtracked = refuseBacktracking();

        // Act
        const result = sut('(a+)+b\\1c')?.test(`${EXPONENTIAL_SUBJECT} abac`);

        // Assert
        expect(result).toBe(false);
        expect(backtracked).toEqual([]);
      });
    });

    describe('When the check throws', () => {
      it('Then the throw stops the match', () => {
        // Arrange
        const sut = compileExtendedRegex;
        refuseBacktracking();

        // Act
        let result: unknown;
        try {
          sut('(a+)+b\\1c')?.test(EXPONENTIAL_SUBJECT, stop);
        } catch (error) {
          result = error;
        }

        // Assert
        expect(result).toBe(STOP);
      });
    });
  });

  describe('Given a back-reference after nested repetitions of bodies that may read nothing', () => {
    describe('When the copies reading nothing record no group the back-reference reads', () => {
      it('Then they are pruned, and the match settles before the check is consulted', () => {
        // Arrange
        const sut = compileExtendedRegex;
        const { check, calls } = countingCheck(0);

        // Act
        const result = sut('(((.{0,2}|b?)*)*)\\1')?.test('aa\né\n  é', check);

        // Assert
        expect(result).toBe(true);
        expect(calls()).toBe(0);
      });
    });
  });

  describe('Given a back-reference pattern splitting every word of a long message', () => {
    describe('When the match lies at the message end', () => {
      it('Then the steps the message length allows find it', () => {
        // Arrange
        const sut = compileExtendedRegex;
        const body = PROSE.repeat(Math.ceil(LONG_MESSAGE_LENGTH / PROSE.length));
        const { check } = countingCheck(budgetChecks(body) + 1);

        // Act
        const result = sut('([a-z]+) \\1 q')?.test(`${body}abc abc q`, check);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a back-reference after a repeated alternation over a long run', () => {
    describe.each([
      { run: COPIES_AT_BOUND / 4, expected: true },
      { run: COPIES_AT_BOUND * 1.25, expected: false },
    ])('When the run is $run characters long', ({ run, expected }) => {
      it(`Then it answers ${expected}: past its bound, the path's records end the match`, () => {
        // Arrange
        const sut = compileExtendedRegex;
        const text = `x${'a'.repeat(run)}x`;
        const { check } = countingCheck(budgetChecks(text) + 1);

        // Act
        const result = sut('(x)(a|b)*\\1')?.test(text, check);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given a back-reference after a repeated alternation, past a group whose records align its bound with a consult', () => {
    describe('When the run is long enough to reach that bound', () => {
      it('Then it answers false at the consult the records reach the bound on', () => {
        // Arrange
        const sut = compileExtendedRegex;
        const text = `yx${'a'.repeat(COPIES_AT_BOUND * 1.25)}xy`;
        const { check, calls } = countingCheck(budgetChecks(text) + 1);

        // Act
        const result = sut('(y)(x)(a|b)*\\2\\1')?.test(text, check);

        // Assert
        expect(result).toBe(false);
        expect(calls()).toBe(STEPS_TO_PATH_BOUND / CHECK_INTERVAL);
      });
    });
  });

  describe('Given a back-reference pattern and a subject holding its match', () => {
    describe('When it is matched', () => {
      it('Then it answers true without RegExp backtracking', () => {
        // Arrange
        const sut = matches;
        const backtracked = refuseBacktracking();

        // Act
        const result = sut('(ab)\\1', 'xabab');

        // Assert
        expect(result).toBe(true);
        expect(backtracked).toEqual([]);
      });
    });
  });

  describe('Given a back-reference after a long repeated run', () => {
    describe('When it is matched', () => {
      it.each([
        { pattern: '(x)a*\\1', subject: `x${'a'.repeat(LONG_RUN_LENGTH)}x`, steps: 1 },
        { pattern: '(x)(ab)*\\1', subject: `x${'ab'.repeat(LONG_RUN_LENGTH / 2)}x`, steps: 3 },
        { pattern: '(x)(a)*\\2\\1', subject: `x${'a'.repeat(LONG_RUN_LENGTH)}x`, steps: 5 },
      ])(
        'Then /$pattern/ takes at most $steps steps per code point',
        ({ pattern, subject, steps }) => {
          // Arrange
          const sut = compileExtendedRegex;
          const ceiling = (steps * LONG_RUN_LENGTH) / CHECK_INTERVAL + 1;
          const { check, calls } = countingCheck(ceiling);

          // Act
          const result = sut(pattern)?.test(subject, check);

          // Assert
          expect(result).toBe(true);
          expect(calls()).toBeLessThanOrEqual(ceiling);
        },
      );
    });
  });

  describe('Given a back-reference repeating a long text many times over', () => {
    describe('When the repetitions are compared in few steps', () => {
      it('Then the compared characters count toward the check', () => {
        // Arrange
        const sut = compileExtendedRegex;
        const text = 'a'.repeat(REPEATED_TEXT_LENGTH);
        const message = `${text}x${text.repeat(REPETITIONS)}zy`;

        // Act
        let result: unknown;
        try {
          sut('^([^x]*)x\\1*\\1*y')?.test(message, stop);
        } catch (error) {
          result = error;
        }

        // Assert
        expect(result).toBe(STOP);
      });
    });

    describe('When a short subject is matched', () => {
      it('Then the match ends before the check is consulted', () => {
        // Arrange
        const sut = compileExtendedRegex;

        // Act
        const result = sut('(a)\\1')?.test('aa', stop);

        // Assert
        expect(result).toBe(true);
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

    describe('When a long subject spells none of the texts each alternative requires', () => {
      it.each([['feat|fix'], ['(feat|fix)[0-9]']])(
        'Then /%s/ refuses it before the automaton steps',
        (pattern) => {
          // Arrange
          const sut = compileExtendedRegex;

          // Act
          const result = sut(pattern)?.test('f'.repeat(LONG_SUBJECT_LENGTH), stop);

          // Assert
          expect(result).toBe(false);
        },
      );
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

    describe('When a match begins past a long run no character of which can begin one', () => {
      it('Then the automaton jumps to the match without stepping', () => {
        // Arrange
        const sut = compileExtendedRegex;

        // Act
        const result = sut('[0-9]{4}')?.test(`${'x'.repeat(LONG_SUBJECT_LENGTH)}1234`, stop);

        // Assert
        expect(result).toBe(true);
      });
    });

    describe.each([
      { pattern: '^b', start: 'a' },
      { pattern: '^(b)\\1', start: 'b' },
    ])(
      'When /$pattern/, anchored at the subject start, fails there before a long subject',
      ({ pattern, start }) => {
        it('Then the match ends before the check is consulted', () => {
          // Arrange
          const sut = compileExtendedRegex;

          // Act
          const result = sut(pattern)?.test(`${start}${'x'.repeat(LONG_SUBJECT_LENGTH)}b`, stop);

          // Assert
          expect(result).toBe(false);
        });
      },
    );
  });

  describe('Given a pattern requiring texts every match holds', () => {
    describe.each([
      { count: MAX_PREFILTER_TEXTS, searched: MAX_PREFILTER_TEXTS },
      { count: MAX_PREFILTER_TEXTS + 1, searched: 0 },
    ])('When it requires $count texts and the message holds them all', ({ count, searched }) => {
      it(`Then the message is searched for ${searched} of them before the automaton runs`, () => {
        // Arrange
        const sut = compileExtendedRegex;
        const { pattern, text } = requiringTexts(count);
        const matcher = sut(pattern);
        const texts = searchedTexts();

        // Act
        const result = matcher?.test(text);

        // Assert
        expect(result).toBe(false);
        expect(texts()).toHaveLength(searched);
      });
    });
  });

  describe('Given a pattern spelling a few texts around a shared one', () => {
    describe('When the message lacks the shared text', () => {
      it('Then it is refused without searching for the spelt texts', () => {
        // Arrange
        const sut = compileExtendedRegex;
        const matcher = sut('a(b|c)zzz');
        const texts = searchedTexts();

        // Act
        const result = matcher?.test('abc ac zz');

        // Assert
        expect(result).toBe(false);
        expect(texts()).toEqual(['a', 'zzz']);
      });
    });
  });

  describe('Given a pattern spelling texts that share none', () => {
    describe('When it is matched', () => {
      it('Then the message is searched for the texts alone', () => {
        // Arrange
        const sut = compileExtendedRegex;
        const matcher = sut('foo|bar');
        const every = vi.spyOn(Array.prototype, 'every');

        // Act
        const result = matcher?.test('a bar');

        // Assert
        expect(result).toBe(true);
        expect(every).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a pattern whose required runs are empty', () => {
    describe('When it is matched', () => {
      it('Then the message is never searched for empty text', () => {
        // Arrange
        const sut = compileExtendedRegex;
        const matcher = sut('(feat|fix)[0-9]');
        const texts = searchedTexts();

        // Act
        const result = matcher?.test('a fix2');

        // Assert
        expect(result).toBe(true);
        expect(texts()).not.toContain('');
      });
    });
  });

  describe('Given a pattern a match may begin with any of several classes', () => {
    describe.each([
      { count: MAX_LEADING_CLASSES, jumps: true },
      { count: MAX_LEADING_CLASSES + 1, jumps: false },
    ])('When $count classes may begin it', ({ count, jumps }) => {
      it(`Then the automaton ${jumps ? 'jumps' : 'steps'} to where one begins`, () => {
        // Arrange
        const sut = compileExtendedRegex;
        const matcher = sut(leadingLetters(count));
        const searches = leadingSearches();

        // Act
        const result = matcher?.test(`a${'x'.repeat(LONG_RUN)}a1`);

        // Assert
        expect(result).toBe(true);
        expect(searches() > 0).toBe(jumps);
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
      it('Then it refuses once the copies laid out pass the budget, not after laying out all', () => {
        // Arrange
        const sut = compileExtendedRegex;
        const from = vi.spyOn(Array, 'from');

        // Act
        const result = sut('a{32767}'.repeat(WIDE_INTERVALS));

        // Assert
        const laidOut = from.mock.calls
          .map(([copies]) => copies)
          .filter((copies) => typeof copies !== 'string')
          .reduce<number>((total, copies) => total + (copies as ArrayLike<unknown>).length, 0);
        expect(result).toBeUndefined();
        expect(laidOut).toBeLessThanOrEqual(MAX_PROGRAM_SIZE + MAX_REPEAT);
      });
    });
  });

  describe('Given a back-reference after an empty group repeated past the backtracking budget', () => {
    describe('When it is compiled', () => {
      it('Then it yields no matcher', () => {
        // Arrange
        const sut = compileExtendedRegex;

        // Act
        const result = sut('((){0,32767}){0,32767}\\2');

        // Assert
        expect(result).toBeUndefined();
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

  describe('Given every group a back-reference can name, nested, repeated by the widest interval', () => {
    describe('When the pattern is compiled', () => {
      it('Then it yields a backtracking matcher', () => {
        // Arrange
        const sut = compileExtendedRegex;

        // Act
        const result = sut(`${nested(NAMEABLE_GROUPS)}{${MAX_REPEAT}}\\1`)?.engine;

        // Assert
        expect(result).toBe('backtracking');
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

  describe('Given a check that counts its consultations', () => {
    describe('When the automaton steps one ready thread per position through a long subject', () => {
      it('Then it is consulted once per interval of stepped threads', () => {
        // Arrange
        const sut = compileExtendedRegex;
        const expected = (STEPPED_PER_POSITION * LONG_SUBJECT_LENGTH) / CHECK_INTERVAL;
        const { check, calls } = countingCheck(expected);

        // Act
        const result = sut('^a*$')?.test('a'.repeat(LONG_SUBJECT_LENGTH), check);

        // Assert
        expect(result).toBe(true);
        expect(calls()).toBe(expected);
      });
    });

    describe.each([
      { run: CHECK_INTERVAL - SPAN_PATTERN_STEPS, checks: 1 },
      { run: CHECK_INTERVAL - SPAN_PATTERN_STEPS - 1, checks: 0 },
    ])('When a span reads a run of $run before a back-reference', ({ run, checks }) => {
      it(`Then the run counts toward the check, consulted ${checks} times`, () => {
        // Arrange
        const sut = compileExtendedRegex;
        const { check, calls } = countingCheck(checks);

        // Act
        const result = sut('(x)a*\\1')?.test(`x${'a'.repeat(run)}x`, check);

        // Assert
        expect(result).toBe(true);
        expect(calls()).toBe(checks);
      });
    });
  });

  describe('Given a pattern requiring a text and choosing among alternatives', () => {
    describe('When only the texts together number past those searched for', () => {
      it('Then the message is searched for none of them', () => {
        // Arrange
        const sut = compileExtendedRegex;
        const matcher = sut(`t0${'.(a|b)'.repeat(MAX_PREFILTER_TEXTS / 2)}`);
        const texts = searchedTexts();

        // Act
        const result = matcher?.test('t0');

        // Assert
        expect(result).toBe(false);
        expect(texts()).toEqual([]);
      });
    });
  });

  describe('Given a repeated literal', () => {
    describe('When it is matched', () => {
      it('Then the message is searched for the literal before the automaton runs', () => {
        // Arrange
        const sut = compileExtendedRegex;
        const matcher = sut('a+');
        const texts = searchedTexts();

        // Act
        const result = matcher?.test('xyz');

        // Assert
        expect(result).toBe(false);
        expect(texts()).toEqual(['a']);
      });
    });
  });

  describe('Given a pattern spelling a few texts', () => {
    describe.each([
      { pattern: letterBranches(MAX_EXACT_TEXTS), automaton: false },
      { pattern: letterBranches(MAX_EXACT_TEXTS + 1), automaton: true },
      { pattern: '(1|2)'.repeat(4), automaton: false },
      { pattern: '(1|2)'.repeat(5), automaton: true },
    ])('When /$pattern/ is matched', ({ pattern, automaton }) => {
      it(`Then it ${automaton ? 'runs the automaton' : 'searches for the texts alone'}`, () => {
        // Arrange
        const sut = compileExtendedRegex;
        const matcher = sut(pattern);
        const every = vi.spyOn(Array.prototype, 'every');

        // Act
        const result = matcher?.test('z');

        // Assert
        expect(result).toBe(false);
        expect(every.mock.calls.length > 0).toBe(automaton);
      });
    });
  });

  describe('Given a pattern no search can place a match of', () => {
    describe.each([['^ab'], ['^a|^b'], ['.[0-9]'], ['(a|.)[0-9]'], ['(a?)\\1x']])(
      'When /%s/ is matched',
      (pattern) => {
        it('Then the automaton never jumps to where a match begins', () => {
          // Arrange
          const sut = compileExtendedRegex;
          const matcher = sut(pattern);
          const searches = leadingSearches();

          // Act
          matcher?.test('zz ab zx1 bx');

          // Assert
          expect(searches()).toBe(0);
        });
      },
    );
  });

  describe('Given a pattern a match begins with one class spelt more times than the classes jumped to', () => {
    describe('When it is matched', () => {
      it('Then the automaton jumps to where the class begins', () => {
        // Arrange
        const sut = compileExtendedRegex;
        const matcher = sut(
          `(${Array.from({ length: MAX_LEADING_CLASSES + 1 }, () => 'a').join('|')})[0-9]`,
        );
        const searches = leadingSearches();

        // Act
        const result = matcher?.test(`a${'x'.repeat(LONG_RUN)}a1`);

        // Assert
        expect(result).toBe(true);
        expect(searches()).toBeGreaterThan(0);
      });
    });
  });

  describe('Given a pattern reading an ASCII character', () => {
    describe('When a thread reads it where a non-ASCII code point stands', () => {
      it('Then no pattern runs to tell them apart', () => {
        // Arrange
        const sut = compileExtendedRegex;
        const matcher = sut('a.*b');
        const test = vi.spyOn(RegExp.prototype, 'test');

        // Act
        const result = matcher?.test('aéb');

        // Assert
        expect(result).toBe(true);
        expect(
          test.mock.contexts.filter(
            (pattern) => (pattern as RegExp).sticky && (pattern as RegExp).source === 'a',
          ),
        ).toEqual([]);
      });
    });
  });

  describe('Given a pattern asserting a word boundary where a match may begin', () => {
    describe('When a run steps onto such a place past a non-ASCII word character', () => {
      it('Then it reads the word class of that character once', () => {
        // Arrange
        const sut = compileExtendedRegex;
        const matcher = sut('\\bfix');
        const reads = wordReads();

        // Act
        const result = matcher?.test('f٣fix');

        // Assert
        expect(result).toBe(false);
        expect(reads()).toBe(1);
      });
    });
  });

  describe('Given widest intervals {0} discards and a run, laid out to the automaton budget', () => {
    describe.each([
      { run: BUDGET_RUN, expected: true },
      { run: BUDGET_RUN + 1, expected: undefined },
    ])('When the run is $run long', ({ run, expected }) => {
      it(`Then it answers ${expected}`, () => {
        // Arrange
        const sut = matches;

        // Act
        const result = sut(`${'a{0,32767}{0}'.repeat(2)}a{${run}}`, 'a'.repeat(run));

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
