import { describe, expect, it } from 'vitest';
import { parseCommitView } from '../../../../src/domain/pretty/commit-view.js';
import {
  type FormatEnv,
  type FormatOutput,
  formatCommit,
  formatRequirements,
  type SignatureCheck,
  scanPlaceholders,
} from '../../../../src/domain/pretty/user-format.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const BUDGET = { describe: 1 } as const;
const COMMIT_ID = '38096f729e6651b8bb39ff91bf665623356a0e2c';
const TREE = 'f3d80e15d4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PARENT_A = 'd948d406d8bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PARENT_B = '1111111111111111111111111111111111111111';
const AUTHOR = 'A U Thor <author@example.com> 1700000200 +0545';
const COMMITTER = 'C O Mitter <committer@example.com> 1700000300 +0000';
const MESSAGE = 'msg subject line\n\nbody para\n\nSigned-off-by: X <x@y>\n';

const rawCommit = (message: string = MESSAGE): Uint8Array =>
  encode(
    `tree ${TREE}\nparent ${PARENT_A}\nparent ${PARENT_B}\nauthor ${AUTHOR}\ncommitter ${COMMITTER}\n\n${message}`,
  );

const ENV: FormatEnv = {
  commitId: COMMIT_ID,
  abbrev: (kind) => ({ commit: '38096f7', tree: 'f3d80e1', parents: 'd948d40 1111111' })[kind],
  nowSeconds: 1790000000,
  localOffsetMinutes: 0,
};

const run = (
  format: string,
  raw: Uint8Array = rawCommit(),
  env: FormatEnv = ENV,
): FormatOutput | { readonly refused: string } => {
  const sut = formatCommit;
  return sut(scanPlaceholders(encode(format)), parseCommitView(raw), env, BUDGET) as
    | FormatOutput
    | { readonly refused: string };
};

const expand = (format: string, raw?: Uint8Array, env?: FormatEnv): string => {
  const result = run(format, raw, env);
  if ('refused' in result) throw new Error(`refused ${result.refused}`);
  return decode(result.bytes);
};

describe('formatCommit literals', () => {
  describe.each([
    ['plain text', 'hello', 'hello'],
    ['an empty format', '', ''],
    ['a line feed', 'a%nb', 'a\nb'],
    ['a percent', '100%%', '100%'],
    ['a hex byte', '%x41', 'A'],
    ['a lowercase hex byte', '%x4a', 'J'],
    ['an uppercase hex byte', '%x4A', 'J'],
    ['a hex byte at the top of the range', '%x7e', '~'],
    ['a trailing percent', 'a%', 'a%'],
    ['a bad hex byte', '%xZZ', '%xZZ'],
    ['a half-bad hex byte', '%x4Z', '%x4Z'],
    ['a short hex byte', '%x4', '%x4'],
    ['a hex lead digit outside the alphabet', '%xG1', '%xG1'],
    ['a hex digit just past 9', '%x:0', '%x:0'],
    ['a hex digit just before a', '%x`0', '%x`0'],
    ['a hex digit just before A', '%x@0', '%x@0'],
  ])('Given %s, When expanding', (_title, format, expected) => {
    it(`Then it yields "${expected}"`, () => {
      // Arrange
      const sut = expand;

      // Act
      const result = sut(format);

      // Assert
      expect(result).toBe(expected);
    });
  });

  describe('Given %x00, When expanding', () => {
    it('Then it yields one NUL byte', () => {
      // Arrange
      const sut = run;

      // Act
      const result = (sut('%x00') as FormatOutput).bytes;

      // Assert
      expect(Array.from(result)).toEqual([0]);
    });
  });
});

describe('formatCommit magic', () => {
  describe.each([
    ['%+ before a non-empty value', 'a%+n', 'a\n\n'],
    ['%- keeps line feeds before a non-empty value', 'x\n%-n', 'x\n\n'],
    ['% before a non-empty value', 'a% n', 'a \n'],
    ['%- after line feeds with an empty value', 'x\n\n%-%gd', 'x'],
    ['%+ with an empty value', 'a%+%gd', 'a'],
    ['% with an empty value', 'a% %gd', 'a'],
    ['%- stops at non-line-feed bytes', 'x \n%-%gd', 'x '],
    ['a declined placeholder under %+ keeps the rest', '%+N', 'N'],
    ['a declined placeholder under %- trims line feeds', 'x\n%-N', 'xN'],
    ['a declined placeholder under % keeps the rest', 'a% N', 'aN'],
    ['a declined placeholder without magic', '%N', '%N'],
    ['a wrap placeholder under %+', '%+w(5)', '%+w(5)'],
    ['a wrap placeholder under %-', '%-w(5)', '%-w(5)'],
    ['a wrap placeholder under a space', '% w(5)', '% w(5)'],
  ])('Given %s, When expanding', (_title, format, expected) => {
    it(`Then it yields ${JSON.stringify(expected)}`, () => {
      // Arrange
      const sut = expand;

      // Act
      const result = sut(format);

      // Assert
      expect(result).toBe(expected);
    });
  });
});

const raw = (headers: ReadonlyArray<string>, message: string = MESSAGE): Uint8Array =>
  encode(`${headers.join('\n')}\n\n${message}`);

const NO_PARENT_HEADERS = [`tree ${TREE}`, `author ${AUTHOR}`, `committer ${COMMITTER}`];

describe('formatCommit commit ids', () => {
  describe.each([
    ['%H', COMMIT_ID],
    ['%T', TREE],
    ['%P', `${PARENT_A} ${PARENT_B}`],
    ['%h', '38096f7'],
    ['%t', 'f3d80e1'],
    ['%p', 'd948d40 1111111'],
  ])('Given %s, When expanding', (format, expected) => {
    it(`Then it yields ${expected}`, () => {
      // Arrange
      const sut = expand;

      // Act
      const result = sut(format);

      // Assert
      expect(result).toBe(expected);
    });
  });

  describe('Given a commit without a tree line, When expanding', () => {
    it('Then %T yields nothing', () => {
      // Arrange
      const sut = expand;

      // Act
      const result = sut('[%T]', raw([`author ${AUTHOR}`]));

      // Assert
      expect(result).toBe('[]');
    });
  });

  describe('Given a commit without parents, When expanding', () => {
    it('Then %P yields nothing', () => {
      // Arrange
      const sut = expand;

      // Act
      const result = sut('[%P]', raw(NO_PARENT_HEADERS));

      // Assert
      expect(result).toBe('[]');
    });
  });
});

describe('formatCommit idents', () => {
  describe.each([
    ['%an', 'A U Thor'],
    ['%ae', 'author@example.com'],
    ['%al', 'author'],
    ['%at', '1700000200'],
    ['%aN', 'A U Thor'],
    ['%aE', 'author@example.com'],
    ['%aL', 'author'],
    ['%cn', 'C O Mitter'],
    ['%ce', 'committer@example.com'],
    ['%cl', 'committer'],
    ['%ct', '1700000300'],
    ['%cN', 'C O Mitter'],
  ])('Given %s, When expanding', (format, expected) => {
    it(`Then it yields ${expected}`, () => {
      // Arrange
      const sut = expand;

      // Act
      const result = sut(format);

      // Assert
      expect(result).toBe(expected);
    });
  });

  describe('Given an address without an at sign, When expanding', () => {
    it('Then %al yields the whole address', () => {
      // Arrange
      const sut = expand;

      // Act
      const result = sut('%al', raw(['author A <nohost> 1 +0000']));

      // Assert
      expect(result).toBe('nohost');
    });
  });

  describe('Given a mailmap, When expanding', () => {
    const mapUser: FormatEnv['mapUser'] = () => ({
      name: encode('Mapped Name'),
      mail: encode('mapped@example.com'),
    });
    const mapped: FormatEnv = { ...ENV, mapUser };

    it.each([
      ['%aN', 'Mapped Name'],
      ['%aE', 'mapped@example.com'],
      ['%aL', 'mapped'],
      ['%cN', 'Mapped Name'],
      ['%an', 'A U Thor'],
      ['%ae', 'author@example.com'],
      ['%al', 'author'],
    ])('Then %s yields %s', (format, expected) => {
      // Arrange
      const sut = expand;

      // Act
      const result = sut(format, undefined, mapped);

      // Assert
      expect(result).toBe(expected);
    });

    it('Then the mailmap receives the ident name and address', () => {
      // Arrange
      const seen: string[] = [];
      const recording: FormatEnv = {
        ...ENV,
        mapUser: (ident) => {
          seen.push(`${decode(ident.name)}|${decode(ident.mail)}`);
          return ident;
        },
      };
      const sut = expand;

      // Act
      sut('%aN', undefined, recording);

      // Assert
      expect(seen).toEqual(['A U Thor|author@example.com']);
    });
  });

  describe.each([
    ['a missing header', ['tree x']],
    ['an ident without an address', ['author anonymous 1700000300 +0000']],
  ])('Given %s, When expanding', (_title, headers) => {
    it.each([
      ['%an', ''],
      ['%ae', ''],
      ['%at', ''],
      ['%ad', ''],
      ['%aD', ''],
      ['%ar', ''],
      ['%ai', ''],
      ['%al', '%al'],
      ['%aL', '%aL'],
      ['%aN', '%aN'],
      ['%aE', '%aE'],
      ['%aI', '%aI'],
      ['%as', '%as'],
      ['%ah', '%ah'],
      ['%aX', '%aX'],
    ])('Then %s yields %s', (format, expected) => {
      // Arrange
      const sut = expand;

      // Act
      const result = sut(format, raw(headers));

      // Assert
      expect(result).toBe(expected);
    });
  });

  describe('Given an ident without a date, When expanding', () => {
    it.each([
      ['%an', 'A'],
      ['%at', ''],
      ['%ad', ''],
      ['%as', '%as'],
    ])('Then %s yields %s', (format, expected) => {
      // Arrange
      const sut = expand;

      // Act
      const result = sut(format, raw(['author A <a@b>']));

      // Assert
      expect(result).toBe(expected);
    });
  });

  describe.each([
    ['%ad', 'Wed Nov 15 04:01:40 2023 +0545'],
    ['%aD', 'Wed, 15 Nov 2023 04:01:40 +0545'],
    ['%ai', '2023-11-15 04:01:40 +0545'],
    ['%aI', '2023-11-15T04:01:40+05:45'],
    ['%as', '2023-11-15'],
    ['%ah', 'Nov 15 2023'],
    ['%ar', '2 years, 10 months ago'],
    ['%cd', 'Tue Nov 14 22:18:20 2023 +0000'],
    ['%cD', 'Tue, 14 Nov 2023 22:18:20 +0000'],
    ['%ci', '2023-11-14 22:18:20 +0000'],
    ['%cI', '2023-11-14T22:18:20Z'],
    ['%cs', '2023-11-14'],
    ['%ch', 'Nov 14 2023'],
    ['%cr', '2 years, 10 months ago'],
  ])('Given a well-formed ident, When expanding %s', (format, expected) => {
    it(`Then it yields ${expected}`, () => {
      // Arrange
      const sut = expand;

      // Act
      const result = sut(format);

      // Assert
      expect(result).toBe(expected);
    });
  });

  describe('Given a clock far from the commit, When expanding the now-relative placeholders', () => {
    it('Then %ar and %ah follow the injected now and local offset', () => {
      // Arrange
      const sut = expand;
      const env: FormatEnv = { ...ENV, nowSeconds: 1700000300 + 30 * 60, localOffsetMinutes: 0 };

      // Act
      const result = sut('%cr|%ch', undefined, env);

      // Assert
      expect(result).toBe('30 minutes ago|30 minutes ago');
    });
  });

  describe('Given an ident west of UTC, When expanding', () => {
    it('Then %ai and %aI render the negative zone', () => {
      // Arrange
      const sut = expand;

      // Act
      const result = sut('%ai|%aI', raw(['author A <a@b> 1700000200 -0130']));

      // Assert
      expect(result).toBe('2023-11-14 20:46:40 -0130|2023-11-14T20:46:40-01:30');
    });
  });

  describe('Given a date placeholder under a magic prefix, When expanding', () => {
    it('Then %+as adds a line feed before the date', () => {
      // Arrange
      const sut = expand;

      // Act
      const result = sut('x%+as');

      // Assert
      expect(result).toBe('x\n2023-11-15');
    });
  });
});

describe('formatCommit message placeholders', () => {
  describe.each([
    ['%s', 'msg subject line'],
    ['%f', 'msg-subject-line'],
    ['%b', 'body para\n\nSigned-off-by: X <x@y>\n'],
    ['%B', MESSAGE],
    ['%e', ''],
    ['%m', '>'],
    ['%gd', ''],
    ['%gD', ''],
    ['%gs', ''],
    ['%gn', ''],
    ['%gN', ''],
    ['%ge', ''],
    ['%gE', ''],
  ])('Given %s, When expanding', (format, expected) => {
    it(`Then it yields ${JSON.stringify(expected)}`, () => {
      // Arrange
      const sut = expand;

      // Act
      const result = sut(format);

      // Assert
      expect(result).toBe(expected);
    });
  });

  describe('Given a multi-line subject paragraph, When expanding', () => {
    it('Then %s joins the lines with spaces', () => {
      // Arrange
      const sut = expand;

      // Act
      const result = sut('%s', rawCommit('one\ntwo\n\nbody\n'));

      // Assert
      expect(result).toBe('one two');
    });
  });

  describe('Given an encoding header, When expanding', () => {
    it('Then %e yields it verbatim', () => {
      // Arrange
      const sut = expand;

      // Act
      const result = sut('%e', raw([...NO_PARENT_HEADERS, 'encoding ISO-8859-1']));

      // Assert
      expect(result).toBe('ISO-8859-1');
    });
  });
});

describe('Given declined placeholders, When expanding', () => {
  it('Then a magic byte closing the format is consumed', () => {
    // Arrange
    const sut = expand;

    // Act
    const result = sut('a%+');

    // Assert
    expect(result).toBe('a');
  });

  it.each([
    '%S',
    '%N',
    '%q',
    '%Zz',
    '%xZZ',
    '%Gx',
    '%(unknown)',
    '%gx',
    '%a',
    '%',
    '%C(red',
    '%Cx',
    '%w(5',
    '%w(5,x)',
    '%w(16385)',
    '%<(3',
    '%<(0)',
    '%<(x)',
    '%>(-3)',
    '%<(16385)',
  ])('Then %s is emitted literally', (format) => {
    // Arrange
    const sut = expand;

    // Act
    const result = sut(format);

    // Assert
    expect(result).toBe(format);
  });
});

describe('Given colour placeholders, When expanding', () => {
  it.each([
    '%Cred',
    '%Cgreen',
    '%Cblue',
    '%Creset',
    '%C(red)',
    '%C(auto)',
    '%C(auto,red)',
    '%C(never,red)',
    '%C(bold blue)',
    '%C(bogus)',
    '%C(auto,bogus)',
    '%C()',
  ])('Then %s emits nothing because archive colour is never', (format) => {
    // Arrange
    const sut = expand;

    // Act
    const result = sut(`a${format}b`);

    // Assert
    expect(result).toBe('ab');
  });

  it.each([
    ['%C(always,red)X', '\x1b[31mX'],
    ['%C(always,bold red blue)x', '\x1b[1;31;44mx'],
    ['%C(always,reset)', '\x1b[m'],
    ['%C(always,)', ''],
    ['%C(always,normal)', ''],
    ['%C(always,#ff8000)', '\x1b[38;2;255;128;0m'],
  ])('Then %s yields %j', (format, expected) => {
    // Arrange
    const sut = expand;

    // Act
    const result = sut(format);

    // Assert
    expect(result).toBe(expected);
  });

  it.each(['%C(always,red'])('Then %s is declined', (format) => {
    // Arrange
    const sut = expand;

    // Act
    const result = sut(format);

    // Assert
    expect(result).toBe(format);
  });

  it('Then text after a basic colour name is kept', () => {
    // Arrange
    const sut = expand;

    // Act
    const result = sut('%Credx%Cresetting');

    // Assert
    expect(result).toBe('xting');
  });
});

describe('Given an unparsable colour spec, When expanding', () => {
  it.each([
    '%C(always,bogus)z',
    'ab%C(always,bold bogus)',
    '%<(5)%C(always,bogus)',
    '%C(always,red blue green)',
  ])('Then %s is refused as git aborts on it', (format) => {
    // Arrange
    const sut = run;

    // Act
    const result = sut(format);

    // Assert
    expect(result).toEqual({ refused: '%C' });
  });

  it.each(['%C(bogus)', '%C(auto,bogus)', '%C(never,bogus)'])(
    'Then %s stays silent because colour is never wanted',
    (format) => {
      // Arrange
      const sut = expand;

      // Act
      const result = sut(format);

      // Assert
      expect(result).toBe('');
    },
  );
});

describe('Given padding placeholders, When expanding', () => {
  it.each([
    ['%<(10)%an|', 'A U Thor  |'],
    ['%>(10)%an|', '  A U Thor|'],
    ['%><(11)%an|', ' A U Thor  |'],
    ['%<(3,trunc)%an|', 'A..|'],
    ['%<(4,ltrunc)%an|', '..or|'],
    ['%<(6,mtrunc)%an|', 'A ..or|'],
    ['%<(8)%an|', 'A U Thor|'],
    ['%<(6)%x41|', 'A     |'],
    ['%<(4)%%|', '%|'],
    ['%<(5)ab%an|', 'abA U Thor|'],
    ['%<(3)|', '|'],
  ])('Then %s yields %j', (format, expected) => {
    // Arrange
    const sut = expand;

    // Act
    const result = sut(format);

    // Assert
    expect(result).toBe(expected);
  });

  it.each([
    ['ab%<|(12)%h|', 'ab38096f7   |'],
    ['ab%<|(6)%h|', 'ab38096f7|'],
    ['one\ntwo%<|(8)%h|', 'one\ntwo38096f7|'],
    ['one\nab%<|(11)%h|', 'one\nab38096f7  |'],
    ['%<|(-70)%an|', 'A U Thor  |'],
  ])('Then the column form %s yields %j', (format, expected) => {
    // Arrange
    const sut = expand;

    // Act
    const result = sut(format);

    // Assert
    expect(result).toBe(expected);
  });

  it.each([
    ['xx   %>>(4)%an|', 'xxA U Thor|'],
    ['xx      %>>(10)%an|', 'xx        A U Thor|'],
    ['xx  %>>(10)%an|', 'xx    A U Thor|'],
    ['ab  %C(always,red) %>>(3)%an|', 'ab\x1b[31mA U Thor|'],
    ['xx  %>>(8)%an|', 'xx  A U Thor|'],
    ['xx      %>>(8)%an|', 'xx      A U Thor|'],
  ])('Then the stealing form %s yields %j', (format, expected) => {
    // Arrange
    const sut = expand;

    // Act
    const result = sut(format);

    // Assert
    expect(result).toBe(expected);
  });
});

describe('Given the placeholder after the padding is not a value, When expanding', () => {
  it.each([
    ['%<(5)%zz|', '     %zz|'],
    ['%<(5)%Cx|', '     %Cx|'],
    ['%<(5)%<(6)%an|', '     A U Thor|'],
    ['%<(5)%w(0)%an|', '     A U Thor|'],
    ['%<(10,foo)%an|', '%<(10,foo)A U Thor  |'],
    ['%<(10,)%an|', '%<(10,)A U Thor  |'],
    ['%<(3,foo)%<(3,trunc)%an|', '%<(3,foo)   A U Thor|'],
  ])('Then %s yields %j', (format, expected) => {
    // Arrange
    const sut = expand;

    // Act
    const result = sut(format);

    // Assert
    expect(result).toBe(expected);
  });
});

describe('Given colour modifiers before the value, When expanding', () => {
  it.each([
    ['%<(10)%C(always,red)%an|', '\x1b[31mA U Thor  |'],
    ['%<(3,trunc)%C(always,red)%an%C(always,reset)|', '\x1b[31mA..\x1b[m|'],
    ['%<(10)%Cred%an|', 'A U Thor  |'],
    ['%<(10)%C(always,red)%zz|', '\x1b[31m          zz|'],
    ['%>(10)%C(always,red)%C(always,bold)%an|', '  \x1b[31m\x1b[1mA U Thor|'],
    ['%<(10)%C(always,red)x%an|', '\x1b[31m          x' + 'A U Thor|'],
  ])('Then %s yields %j', (format, expected) => {
    // Arrange
    const sut = expand;

    // Act
    const result = sut(format);

    // Assert
    expect(result).toBe(expected);
  });
});

describe('Given a magic byte before the padded value, When expanding', () => {
  it.each([
    ['%<(5)%+an|', '\nA U Thor|'],
    ['%<(10)% an|', ' A U Thor  |'],
    ['%+<(5)%an|', 'A U Thor|'],
    ['a%n%-<(5)%an|', 'aA U Thor|'],
    ['%<(5)%-e|', '     |'],
  ])('Then %s yields %j', (format, expected) => {
    // Arrange
    const sut = expand;

    // Act
    const result = sut(format);

    // Assert
    expect(result).toBe(expected);
  });
});

describe('Given the formatting limit, When expanding', () => {
  it('Then the limit pads to its width', () => {
    // Arrange
    const sut = expand;

    // Act
    const result = sut('%<(16384)%an|');

    // Assert
    expect(result).toBe(`A U Thor${' '.repeat(16384 - 8)}|`);
  });

  it('Then one past the limit is no placeholder', () => {
    // Arrange
    const sut = expand;

    // Act
    const result = sut('%<(16385)%an|');

    // Assert
    expect(result).toBe('%<(16385)A U Thor|');
  });
});

describe('Given wrap placeholders, When expanding', () => {
  it.each([
    ['%w(10,2,4)%s', '  msg\n    subject\n    line'],
    ['%w(10,2,4)the quick brown fox jumps', '  the\n    quick\n    brown\n    fox\n    jumps'],
    ['%w(0,2,4)ab cd%nef', '  ab cd\n    ef'],
    ['%w(5,0,0)ab%ncd ef gh', 'ab cd\nef gh'],
    ['x%w(4,1,1)ab cd%w(0,0,0) ef  gh', 'x ab\n cd ef  gh'],
    ['%w(5)ab cd ef%w(10)gh ij kl mn', 'ab cd\nefgh ij kl\nmn'],
    ['%w(5,0,0)ab cd ef%x00gh ij', 'ab cd\nef'],
    ['%w()ab cd', 'ab cd'],
    ['%w(0,3,5)', ''],
    ['%w(5)%C(always,red)ab cd ef%C(always,reset)', '\x1b[31mab cd\nef\x1b[m'],
    ['a%w(5)b%nc', 'ab c'],
  ])('Then %s yields %j', (format, expected) => {
    // Arrange
    const sut = expand;

    // Act
    const result = sut(format);

    // Assert
    expect(result).toBe(expected);
  });

  it('Then a magic byte before it declines the whole placeholder', () => {
    // Arrange
    const sut = expand;

    // Act
    const result = sut('%+w(5)ab cd ef');

    // Assert
    expect(result).toBe('%+w(5)ab cd ef');
  });

  it('Then line feeds alone are all deleted by a magic delete', () => {
    // Arrange
    const sut = expand;

    // Act
    const result = sut('%n%n%-e');

    // Assert
    expect(result).toBe('');
  });

  it('Then a wrap tail emptied by a deleted line feed is not wrapped', () => {
    // Arrange
    const sut = expand;

    // Act
    const result = sut('ab\n%w(5)%-e', rawCommit());

    // Assert
    expect(result).toBe('ab');
  });
});

describe('Given refused placeholders, When expanding', () => {
  it.each(['%(count)', '%(total)'])('Then %s is refused with its own name', (placeholder) => {
    // Arrange
    const sut = run;

    // Act
    const result = sut(`before ${placeholder} after`);

    // Assert
    expect(result).toEqual({ refused: placeholder });
  });

  it('Then a refusal under a magic byte is still refused', () => {
    // Arrange
    const sut = run;

    // Act
    const result = sut('%+(count)');

    // Assert
    expect(result).toEqual({ refused: '%(count)' });
  });

  it.each(['%(counter)', '%(cou)', '%(totally)', '%(count'])(
    'Then %s is declined, not refused',
    (format) => {
      // Arrange
      const sut = expand;

      // Act
      const result = sut(format);

      // Assert
      expect(result).toBe(format);
    },
  );
});

describe('Given header-parsing and header-free placeholders, When expanding', () => {
  it.each([
    ['%h', false],
    ['%H%T%P%t%p', false],
    ['%n%%%x41', false],
    ['%S%N%d%D%Cred%w(5)%<(3)%>(3)%Gx', false],
    ['%m%gd', false],
    ['%(describe)%(decorate)', false],
    ['plain', false],
    ['%e', true],
    ['%an', true],
    ['%cn', true],
    ['%s', true],
    ['%f', true],
    ['%b', true],
    ['%B', true],
    ['%Zz', true],
    ['%xZZ', true],
    ['%aX', true],
    ['%(unknown)', true],
    ['%', true],
    ['%h%e', true],
    ['%e%h', true],
  ])('Then %s reports parsedHeader=%s', (format, expected) => {
    // Arrange
    const sut = run;

    // Act
    const result = sut(format) as FormatOutput;

    // Assert
    expect(result.parsedHeader).toBe(expected);
  });
});

describe('Given the describe budget, When expanding', () => {
  it('Then the budget is handed back untouched', () => {
    // Arrange
    const sut = run;

    // Act
    const result = sut('%h') as FormatOutput;

    // Assert
    expect(result.budget).toBe(BUDGET);
  });
});

describe('Given trailers placeholders, When expanding', () => {
  it.each([
    ['%(trailers)', 'Signed-off-by: X <x@y>\n'],
    ['%(trailers:only)', 'Signed-off-by: X <x@y>\n'],
    ['%(trailers:key=Signed-off-by,valueonly)', 'X <x@y>\n'],
    ['[%+(trailers)]', '[\nSigned-off-by: X <x@y>\n]'],
    ['[%(trailers:key=nope)]', '[]'],
    ['[%-(trailers:key=nope)]', '[]'],
    ['%(trailersx)', '%(trailersx)'],
    ['%(trailers:bogus)', '%(trailers:bogus)'],
  ])('Then %s expands to the block git prints', (format, expected) => {
    // Arrange
    const sut = expand;

    // Act
    const result = sut(format);

    // Assert
    expect(result).toBe(expected);
  });

  it('Then the trailer block is searched from the subject, after leading blank lines', () => {
    // Arrange
    const raw = rawCommit('\n\nsubject\n\nFixes: 1\n');

    // Act
    const result = expand('%(trailers:only)', raw);

    // Assert
    expect(result).toBe('Fixes: 1\n');
  });

  it('Then the configured separators and token keys reach the parser', () => {
    // Arrange
    const raw = rawCommit('subject\n\none\ntwo\nthree\nAck=me\n');
    const env = { ...ENV, trailer: { separators: '=', keys: new Map([['ack', 'Acked-by']]) } };

    // Act
    const result = expand('%(trailers:only)', raw, env);

    // Assert
    expect(result).toBe('Acked-by= me\n');
  });

  it.each([['%(trailers)'], ['%(trailers:only)']])(
    'Then %s reports that the header was parsed',
    (format) => {
      // Arrange
      const sut = run;

      // Act
      const result = sut(format) as FormatOutput;

      // Assert
      expect(result.parsedHeader).toBe(true);
    },
  );
});

describe('Given ref decorations in the environment', () => {
  const decorated: FormatEnv = {
    ...ENV,
    decorations: [
      { kind: 'head', name: 'HEAD', attachedTo: 'refs/heads/main' },
      { kind: 'branch', name: 'refs/heads/main' },
      { kind: 'tag', name: 'refs/tags/v1' },
    ],
  };

  describe('When expanding %d', () => {
    it('Then the decorations render with the default affixes', () => {
      // Arrange
      const sut = expand;

      // Act
      const result = sut('[%d]', undefined, decorated);

      // Assert
      expect(result).toBe('[ (HEAD -> main, tag: v1)]');
    });
  });

  describe('When expanding %D', () => {
    it('Then the decorations render without prefix and suffix', () => {
      // Arrange
      const sut = expand;

      // Act
      const result = sut('[%D]', undefined, decorated);

      // Assert
      expect(result).toBe('[HEAD -> main, tag: v1]');
    });
  });

  describe('When expanding %(decorate) with options', () => {
    it('Then the options replace the affixes', () => {
      // Arrange
      const sut = expand;

      // Act
      const result = sut('%(decorate:prefix=[,suffix=])|%(decorate)', undefined, decorated);

      // Assert
      expect(result).toBe('[HEAD -> main, tag: v1]| (HEAD -> main, tag: v1)');
    });
  });

  describe('When expanding an unparsable %(decorate:bogus)', () => {
    it('Then it is emitted literally', () => {
      // Arrange
      const sut = expand;

      // Act
      const result = sut('%(decorate:bogus)', undefined, decorated);

      // Assert
      expect(result).toBe('%(decorate:bogus)');
    });
  });

  describe('When the commit carries no decoration', () => {
    it('Then %d, %D and %(decorate) expand to nothing', () => {
      // Arrange
      const sut = expand;

      // Act
      const result = sut('[%d%D%(decorate)]');

      // Assert
      expect(result).toBe('[]');
    });
  });

  describe('When a decoration placeholder is padded', () => {
    it('Then the expansion is padded like any value', () => {
      // Arrange
      const sut = expand;

      // Act
      const result = sut('%<(14)%D|', undefined, {
        ...ENV,
        decorations: [{ kind: 'branch', name: 'refs/heads/x' }],
      });

      // Assert
      expect(result).toBe('x             |');
    });
  });

  describe('When expanding decoration placeholders', () => {
    it('Then the commit header is not parsed', () => {
      // Arrange
      const tokens = scanPlaceholders(encode('%d%D%(decorate)'));

      // Act
      const result = formatCommit(tokens, parseCommitView(rawCommit()), decorated, BUDGET);

      // Assert
      expect(result).toMatchObject({ parsedHeader: false });
    });
  });
});

describe('formatCommit commit encoding', () => {
  const LATIN1_E_ACUTE = 0xe9;
  const latin1Commit = (): Uint8Array => {
    const header = encode(
      `tree ${TREE}\nauthor A <j@x> 1700000200 +0000\ncommitter ${COMMITTER}\nencoding ISO-8859-1\n\n`,
    );
    return Uint8Array.from([...header, ...encode('caf'), LATIN1_E_ACUTE, ...encode(' subj\n')]);
  };

  describe('Given a Latin-1 commit, When the subject is expanded', () => {
    it('Then the message is decoded to UTF-8 for the placeholder', () => {
      // Arrange
      const sut = formatCommit;
      const tokens = scanPlaceholders(encode('%s'));

      // Act
      const result = sut(tokens, parseCommitView(latin1Commit()), ENV, BUDGET) as FormatOutput;

      // Assert
      expect(decode(result.bytes)).toBe('café subj');
    });
  });

  describe('Given a Shift_JIS commit with an invalid sequence, When the message is expanded', () => {
    it('Then the bytes are left as they are', () => {
      // Arrange
      const sut = formatCommit;
      const raw = encode(`tree ${TREE}\ncommitter ${COMMITTER}\nencoding Shift_JIS\n\n`);
      const broken = Uint8Array.from([...raw, 0x81]);

      // Act
      const result = sut(
        scanPlaceholders(encode('%B')),
        parseCommitView(broken),
        ENV,
        BUDGET,
      ) as FormatOutput;

      // Assert
      expect([...result.bytes]).toEqual([0x81]);
    });
  });

  describe.each([
    ['an even-length', 'subj\n', '||UTF-16LE'],
    ['an odd-length', 'subjX\n', 'subjX|A|UTF-16LE'],
  ])(
    'Given %s UTF-16LE commit with ASCII bytes, When subject and author expand',
    (_t, message, expected) => {
      it('Then the whole commit buffer is decoded first, or left as is when it cannot be', () => {
        // Arrange
        const sut = formatCommit;
        const raw = encode(
          `tree ${TREE}\nauthor A <j@x> 1700000200 +0000\ncommitter ${COMMITTER}\nencoding UTF-16LE\n\n${message}`,
        );

        // Act
        const result = sut(
          scanPlaceholders(encode('%s|%an|%e')),
          parseCommitView(raw),
          ENV,
          BUDGET,
        ) as FormatOutput;

        // Assert
        expect(decode(result.bytes)).toBe(expected);
      });
    },
  );

  describe('Given a commit encoded utf8, When the subject is expanded', () => {
    it('Then the message is not decoded', () => {
      // Arrange
      const sut = formatCommit;
      const raw = encode(`tree ${TREE}\ncommitter ${COMMITTER}\nencoding utf8\n\ncafé\n`);

      // Act
      const result = sut(
        scanPlaceholders(encode('%s')),
        parseCommitView(raw),
        ENV,
        BUDGET,
      ) as FormatOutput;

      // Assert
      expect(decode(result.bytes)).toBe('café');
    });
  });
});

describe('formatCommit describe placeholders', () => {
  const AVAILABLE = { describe: 1 } as const;
  const SPENT = { describe: 0 } as const;
  const DESCRIBED: FormatEnv = { ...ENV, describe: 'v1-2-g38096f7' };

  const expandWith = (format: string, budget: { readonly describe: 0 | 1 }): FormatOutput => {
    const tokens = scanPlaceholders(encode(format), budget);
    return formatCommit(tokens, parseCommitView(rawCommit()), DESCRIBED, budget) as FormatOutput;
  };

  describe('Given an available budget, When two describe placeholders are expanded', () => {
    it('Then the first is described and the second emitted literally', () => {
      // Arrange
      const sut = expandWith;

      // Act
      const result = sut('%(describe)|%(describe:tags)', AVAILABLE);

      // Assert
      expect(decode(result.bytes)).toBe('v1-2-g38096f7|%(describe:tags)');
      expect(result.budget).toEqual(SPENT);
      expect(result.parsedHeader).toBe(false);
    });
  });

  describe('Given an available budget, When the first describe placeholder is malformed', () => {
    it('Then it is declined and still spends the budget', () => {
      // Arrange
      const sut = expandWith;

      // Act
      const result = sut('%(describe:foo)|%(describe)', AVAILABLE);

      // Assert
      expect(decode(result.bytes)).toBe('%(describe:foo)|%(describe)');
      expect(result.budget).toEqual(SPENT);
    });
  });

  describe('Given a spent budget, When a describe placeholder holds a placeholder', () => {
    it('Then the scan resumes after the percent sign', () => {
      // Arrange
      const sut = expandWith;

      // Act
      const result = sut('%(describe:match=%h)', SPENT);

      // Assert
      expect(decode(result.bytes)).toBe('%(describe:match=38096f7)');
      expect(result.budget).toEqual(SPENT);
    });
  });

  describe('Given an available budget, When the format holds no describe placeholder', () => {
    it('Then the budget is handed back untouched', () => {
      // Arrange
      const sut = expandWith;

      // Act
      const result = sut('%h', AVAILABLE);

      // Assert
      expect(result.budget).toEqual(AVAILABLE);
    });
  });

  describe('Given an environment without a description, When describing', () => {
    it('Then it expands to nothing', () => {
      // Arrange
      const sut = formatCommit;
      const tokens = scanPlaceholders(encode('[%(describe)]'), AVAILABLE);

      // Act
      const result = sut(tokens, parseCommitView(rawCommit()), ENV, AVAILABLE) as FormatOutput;

      // Assert
      expect(decode(result.bytes)).toBe('[]');
    });
  });
});

describe('formatCommit signature placeholders', () => {
  const GOOD: SignatureCheck = {
    result: 'G',
    trust: 'fully',
    signer: 'A U Thor <author@example.com>',
    key: 'ABCDEF0123456789',
    fingerprint: 'F1F2',
    primaryKeyFingerprint: 'P1P2',
    output: 'gpg: Good signature\n',
  };
  const expandSigned = (format: string, signature?: SignatureCheck): string =>
    expand(format, rawCommit(), signature === undefined ? ENV : { ...ENV, signature });

  describe('Given a verified signature, When every signature placeholder is expanded', () => {
    it('Then each reads its field', () => {
      // Arrange
      const sut = expandSigned;

      // Act
      const result = sut('%G?|%GG|%GS|%GK|%GF|%GP|%GT', GOOD);

      // Assert
      expect(result).toBe(
        'G|gpg: Good signature\n|A U Thor <author@example.com>|ABCDEF0123456789|F1F2|P1P2|fully',
      );
    });
  });

  describe.each([
    ['undefined', 'U'],
    ['never', 'U'],
    ['marginal', 'G'],
    ['ultimate', 'G'],
  ] as const)('Given a good signature with %s trust, When %%G? is expanded', (trust, expected) => {
    it(`Then it yields ${expected}`, () => {
      // Arrange
      const sut = expandSigned;

      // Act
      const result = sut('%G?', { ...GOOD, trust });

      // Assert
      expect(result).toBe(expected);
    });
  });

  describe.each(['B', 'E', 'X', 'Y', 'R', 'N'] as const)(
    'Given a %s verification result with undefined trust, When %%G? is expanded',
    (letter) => {
      it('Then it yields the result letter', () => {
        // Arrange
        const sut = expandSigned;

        // Act
        const result = sut('%G?', { ...GOOD, result: letter, trust: 'undefined' });

        // Assert
        expect(result).toBe(letter);
      });
    },
  );

  describe('Given no signature in the environment, When the placeholders are expanded', () => {
    it('Then they read as an unsigned commit', () => {
      // Arrange
      const sut = expandSigned;

      // Act
      const result = sut('%G?|%GG|%GS|%GK|%GF|%GP|%GT|%Gx');

      // Assert
      expect(result).toBe('N||||||undefined|%Gx');
    });
  });

  describe('Given a signature placeholder, When expanding', () => {
    it('Then the commit header is not parsed', () => {
      // Arrange
      const sut = run;

      // Act
      const result = sut('%G?%GT') as FormatOutput;

      // Assert
      expect(result.parsedHeader).toBe(false);
    });
  });
});

describe('formatCommit over the buffer so far', () => {
  const expandAfter = (prefix: string, format: string, raw: Uint8Array = rawCommit()): string => {
    const tokens = scanPlaceholders(encode(format));
    const result = formatCommit(tokens, parseCommitView(raw), ENV, BUDGET, encode(prefix));
    return decode((result as FormatOutput).bytes);
  };

  describe('Given earlier output, When a plain placeholder is expanded', () => {
    it('Then the result is the earlier output followed by the expansion', () => {
      // Arrange
      const sut = expandAfter;

      // Act
      const result = sut('pre ', '%h');

      // Assert
      expect(result).toBe('pre 38096f7');
    });
  });

  describe('Given earlier output ending in line feeds, When an empty %-b is expanded', () => {
    it('Then the line feeds of the earlier output are deleted', () => {
      // Arrange
      const sut = expandAfter;

      // Act
      const result = sut('x\n\n', '%-b', rawCommit('subject only\n'));

      // Assert
      expect(result).toBe('x');
    });
  });

  describe('Given earlier output on the current line, When padding to a column', () => {
    it('Then the column counts the earlier output', () => {
      // Arrange
      const sut = expandAfter;

      // Act
      const result = sut('l1\nabc', '%<|(10)%h|');

      // Assert
      expect(result).toBe('l1\nabc38096f7|');
    });
  });

  describe('Given earlier output, When a wrap layout is applied', () => {
    it('Then only the text after the earlier output is wrapped', () => {
      // Arrange
      const sut = expandAfter;

      // Act
      const result = sut('aaaa bbbb cccc', '%w(4,2,2)x y%w(0,0,0)');

      // Assert
      expect(result).toBe('aaaa bbbb cccc  x\n  y');
    });
  });
});

describe('formatRequirements for resolved data', () => {
  describe.each([
    ['%(count)%h%aN%d%G?%(describe)', false],
    ['%(total)%h%aN%d%G?%(describe)', false],
    ['%C(always,zzz)%h%aN%d%G?%(describe)', false],
    ['%h%aN%d%G?%(describe)%(count)', true],
  ])('Given %s, When reading the requirements', (format, needed) => {
    it(`Then only placeholders before the refusal are required (${needed})`, () => {
      // Arrange
      const sut = formatRequirements;

      // Act
      const result = sut(scanPlaceholders(encode(format), { describe: 1 }));

      // Assert
      expect({
        abbrev: result.abbrev.size > 0,
        mailmap: result.mailmap,
        decorations: result.decorations,
        signature: result.signature,
        describe: result.describe !== undefined,
        refuses: result.refuses,
      }).toEqual({
        abbrev: needed,
        mailmap: needed,
        decorations: needed,
        signature: needed,
        describe: needed,
        refuses: true,
      });
    });
  });

  describe('Given %h without a refusal, When reading the requirements', () => {
    it('Then the format does not refuse', () => {
      // Arrange
      const sut = formatRequirements;

      // Act
      const result = sut(scanPlaceholders(encode('%h')));

      // Assert
      expect(result.refuses).toBe(false);
    });
  });

  describe.each([
    ['%d', true],
    ['%D', true],
    ['%(decorate:prefix=[)', true],
    ['%h%s', false],
  ])('Given %s, When reading the requirements', (format, expected) => {
    it(`Then decorations=${expected}`, () => {
      // Arrange
      const sut = formatRequirements;

      // Act
      const result = sut(scanPlaceholders(encode(format)));

      // Assert
      expect(result.decorations).toBe(expected);
    });
  });

  describe.each([
    ['%G?', true],
    ['%GT', true],
    ['%Gx', false],
    ['%h', false],
  ])('Given %s, When reading the requirements', (format, expected) => {
    it(`Then signature=${expected}`, () => {
      // Arrange
      const sut = formatRequirements;

      // Act
      const result = sut(scanPlaceholders(encode(format)));

      // Assert
      expect(result.signature).toBe(expected);
    });
  });

  describe.each([
    [
      '%(describe:tags)',
      { describe: 1 } as const,
      { args: { tags: true, abbrev: undefined, match: [], exclude: [] } },
    ],
    ['%(describe:foo)', { describe: 1 } as const, { args: undefined }],
    ['%(describe)', { describe: 0 } as const, undefined],
    ['%h', { describe: 1 } as const, undefined],
  ])('Given %s under budget %o, When reading the requirements', (format, budget, expected) => {
    it('Then the describe requirement is the spending placeholder', () => {
      // Arrange
      const sut = formatRequirements;

      // Act
      const result = sut(scanPlaceholders(encode(format), budget));

      // Assert
      expect(result.describe).toEqual(expected);
    });
  });
});
