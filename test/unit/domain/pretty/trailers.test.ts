import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRAILER_OPTIONS,
  formatTrailers,
  parseTrailersPlaceholder,
  type TrailerConfig,
  type TrailerOptions,
} from '../../../../src/domain/pretty/trailers.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const block = (message: string, config: TrailerConfig = {}): string => {
  const sut = formatTrailers;
  return decode(sut(encode(message), DEFAULT_TRAILER_OPTIONS, config));
};

describe('formatTrailers block detection', () => {
  describe('Given a message whose last paragraph is made of trailer lines, When formatting', () => {
    it('Then the block is the last paragraph verbatim', () => {
      // Arrange
      const message = 'subject\n\nbody\n\nFixes: 1\nReviewed-by: X\n';

      // Act
      const result = block(message);

      // Assert
      expect(result).toBe('Fixes: 1\nReviewed-by: X\n');
    });
  });

  describe('Given a message with a single paragraph, When formatting', () => {
    it('Then the title is never a trailer block', () => {
      // Arrange
      const message = 'Fixes: 1\n';

      // Act
      const result = block(message);

      // Assert
      expect(result).toBe('');
    });
  });

  describe('Given a last paragraph mixing trailers and plain lines with no git-generated prefix, When formatting', () => {
    it('Then it is not a trailer block', () => {
      // Arrange
      const message = 'subject\n\nFixes: 1\nplain line\n';

      // Act
      const result = block(message);

      // Assert
      expect(result).toBe('');
    });
  });

  describe('Given a Signed-off-by line among exactly three plain lines (25 percent boundary), When formatting', () => {
    it('Then the paragraph is a trailer block', () => {
      // Arrange
      const message = 'subject\n\none\ntwo\nthree\nSigned-off-by: A <a@b>\n';

      // Act
      const result = block(message);

      // Assert
      expect(result).toBe('one\ntwo\nthree\nSigned-off-by: A <a@b>\n');
    });
  });

  describe('Given a Signed-off-by line among four plain lines (below 25 percent), When formatting', () => {
    it('Then the paragraph is not a trailer block', () => {
      // Arrange
      const message = 'subject\n\none\ntwo\nthree\nfour\nSigned-off-by: A <a@b>\n';

      // Act
      const result = block(message);

      // Assert
      expect(result).toBe('');
    });
  });

  describe('Given a cherry-pick marker among three plain lines, When formatting', () => {
    it('Then the marker counts as a git-generated trailer', () => {
      // Arrange
      const message = 'subject\n\none\ntwo\nthree\n(cherry picked from commit abc123)\n';

      // Act
      const result = block(message);

      // Assert
      expect(result).toBe('one\ntwo\nthree\n(cherry picked from commit abc123)\n');
    });
  });

  describe('Given a cherry-pick marker among four plain lines, When formatting', () => {
    it('Then the paragraph is not a trailer block', () => {
      // Arrange
      const message = 'subject\n\none\ntwo\nthree\nfour\n(cherry picked from commit abc123)\n';

      // Act
      const result = block(message);

      // Assert
      expect(result).toBe('');
    });
  });

  describe('Given indented continuation lines after a trailer, When formatting', () => {
    it('Then they stay inside the block', () => {
      // Arrange
      const message = 'subject\n\nFixes: 1\n  and more\nReviewed-by: X\n';

      // Act
      const result = block(message);

      // Assert
      expect(result).toBe('Fixes: 1\n  and more\nReviewed-by: X\n');
    });
  });

  describe('Given indented lines that follow a plain line, When formatting', () => {
    it('Then they count against the trailer ratio', () => {
      // Arrange
      const message = 'subject\n\nplain\n  indented\nFixes: 1\n';

      // Act
      const result = block(message);

      // Assert
      expect(result).toBe('');
    });
  });

  describe('Given a trailing comment line and a trailing blank line, When formatting', () => {
    it('Then they are ignored when locating the block', () => {
      // Arrange
      const message = 'subject\n\nFixes: 1\n# comment\n\n';

      // Act
      const result = block(message);

      // Assert
      expect(result).toBe('Fixes: 1\n');
    });
  });

  describe('Given a scissors cut line below the trailers, When formatting', () => {
    it('Then everything from the cut line is ignored', () => {
      // Arrange
      const message =
        'subject\n\nFixes: 1\n# ------------------------ >8 ------------------------\nFixes: 2\n';

      // Act
      const result = block(message);

      // Assert
      expect(result).toBe('Fixes: 1\n');
    });
  });

  describe('Given a configured separator set, When formatting', () => {
    it('Then lines using a configured separator are trailers', () => {
      // Arrange
      const message = 'subject\n\nBug #43\nFixes=1\n';

      // Act
      const result = block(message, { separators: '#=' });

      // Assert
      expect(result).toBe('Bug #43\nFixes=1\n');
    });

    it('Then the default colon is no longer a trailer separator', () => {
      // Arrange
      const message = 'subject\n\nFixes: 1\n';

      // Act
      const result = block(message, { separators: '=' });

      // Assert
      expect(result).toBe('');
    });
  });

  describe('Given a configured token among plain lines, When formatting', () => {
    it('Then a line starting with a configured token or key makes the block recognised', () => {
      // Arrange
      const message = 'subject\n\none\ntwo\nthree\nAck: me\n';
      const config = { keys: new Map([['ack', 'Acked-by']]) };

      // Act
      const result = block(message, config);

      // Assert
      expect(result).toBe('one\ntwo\nthree\nAck: me\n');
    });
  });
});

describe('Given degenerate messages, When formatting', () => {
  it.each([
    ['an empty message', ''],
    ['a single character', 'x'],
    ['a cut line only', '# ------------------------ >8 ------------------------\nFixes: 1\n'],
    ['a lone line feed', '\n'],
  ])('Then %s has no trailer block', (_label, message) => {
    // Arrange
    const text = message;

    // Act
    const result = block(text);

    // Assert
    expect(result).toBe('');
  });

  it('Then a last line without a line feed still ends the block', () => {
    // Arrange
    const message = 'subject\n\nFixes: 1\nReviewed-by: X';

    // Act
    const result = block(message);

    // Assert
    expect(result).toBe('Fixes: 1\nReviewed-by: X');
  });

  it('Then a last line made only of token characters is not a trailer', () => {
    // Arrange
    const message = 'subject\n\nFixes: 1\nplain';

    // Act
    const result = block(message);

    // Assert
    expect(result).toBe('');
  });
});

const CUT_LINE = '# ------------------------ >8 ------------------------\n';

describe('Given a message shaped around the block boundaries, When formatting', () => {
  it.each([
    ['a message opening with a blank line keeps its block', '\nFixes: 1\n', 'Fixes: 1\n'],
    ['a whitespace-only line separates paragraphs', 'subject\n\nbody\n \nFixes: 1\n', 'Fixes: 1\n'],
    [
      'whitespace after the last line feed is a skipped blank line',
      'subject\n\nSigned-off-by: A\n\n  ',
      'Signed-off-by: A\n\n  ',
    ],
    ['a tab before the separator still makes a trailer', 'subject\n\nFoo\t: bar\n', 'Foo\t: bar\n'],
    ['a token broken by a space is not a trailer', 'subject\n\nFoo bar: x\n', ''],
    ['a leading cut line hides everything', `${CUT_LINE}subject\n\nFixes: 1\n`, ''],
    [
      'a cut line hides the plain lines below it',
      `subject\n\nFixes: 1\n${CUT_LINE}plain\n`,
      'Fixes: 1\n',
    ],
    [
      'a tab-indented last paragraph outside a Conflicts list stays in the message',
      'subject\n\nFixes: 1\n\n\tindented\n',
      '',
    ],
    [
      'a tab-indented paragraph before any Conflicts list stays in the message',
      '\nFixes: 1\n\n\tx\n',
      '',
    ],
    [
      'a plain line ends a Conflicts list and stays in the message',
      'subject\n\nFixes: 1\n\nConflicts:\n\ta\nplain\n',
      '',
    ],
    [
      'indented lines at the top of the paragraph count against the trailer ratio',
      'subject\n\n a\n b\n c\n d\nSigned-off-by: A\n',
      '',
    ],
    [
      'indented lines under a comment count against the trailer ratio',
      'subject\n\nSigned-off-by: A\n# c\n a\n b\n c\n d\n',
      '',
    ],
  ])('Then %s', (_label, message, expected) => {
    // Arrange
    const text = message;

    // Act
    const result = block(text);

    // Assert
    expect(result).toBe(expected);
  });

  it('Then a configured key the paragraph never names does not recognise it', () => {
    // Arrange
    const config = { keys: new Map([['ack', 'Acked-by']]) };

    // Act
    const result = block('subject\n\nFixes: 1\nplain\n', config);

    // Assert
    expect(result).toBe('');
  });
});

describe('Given comment lines inside the block, When formatting', () => {
  it('Then they stay in the raw block and are dropped from the items', () => {
    // Arrange
    const message = 'subject\n\nFixes: 1\n# note\nReviewed-by: X\n';

    // Act
    const raw = block(message);
    const items = decode(
      formatTrailers(encode(message), { ...DEFAULT_TRAILER_OPTIONS, onlyTrailers: true }),
    );

    // Assert
    expect(raw).toBe('Fixes: 1\n# note\nReviewed-by: X\n');
    expect(items).toBe('Fixes: 1\nReviewed-by: X\n');
  });
});

describe('Given a configured key, When the line is written with that key', () => {
  it('Then the block is recognised and the token stays as written', () => {
    // Arrange
    const message = 'subject\n\none\ntwo\nthree\nAcked-by: me\n';
    const config = { keys: new Map([['ack', 'Acked-by']]) };

    // Act
    const result = decode(
      formatTrailers(encode(message), { ...DEFAULT_TRAILER_OPTIONS, onlyTrailers: true }, config),
    );

    // Assert
    expect(result).toBe('Acked-by: me\n');
  });
});

describe('Given a whitespace-only last line, When formatting', () => {
  it('Then it is skipped when locating the block and kept in it', () => {
    // Arrange
    const message = 'subject\n\nFixes: 1\n  \n';

    // Act
    const result = block(message);

    // Assert
    expect(result).toBe('Fixes: 1\n  \n');
  });
});

describe('Given a configured key ending in a separator, When printing the trailer', () => {
  it('Then no second separator is written', () => {
    // Arrange
    const message = 'subject\n\nplain\nAck: me\n';
    const config = { keys: new Map([['ack', 'Acked-by:']]) };

    // Act
    const result = decode(
      formatTrailers(encode(message), { ...DEFAULT_TRAILER_OPTIONS, onlyTrailers: true }, config),
    );

    // Assert
    expect(result).toBe('Acked-by:me\n');
  });
});

const MIXED =
  'subject\n\nbody\n\nSigned-off-by: A <a@b>\nnot trailer\nAcked-by: B\nFixes: one\n  two\n';

const render = (
  options: Partial<TrailerOptions>,
  config: TrailerConfig = {},
  message: string = MIXED,
): string => {
  const sut = formatTrailers;
  return decode(sut(encode(message), { ...DEFAULT_TRAILER_OPTIONS, ...options }, config));
};

describe('formatTrailers options', () => {
  describe('Given only, When formatting', () => {
    it('Then lines that are not trailers are dropped', () => {
      // Arrange
      const options = { onlyTrailers: true };

      // Act
      const result = render(options);

      // Assert
      expect(result).toBe('Signed-off-by: A <a@b>\nAcked-by: B\nFixes: one\n  two\n');
    });
  });

  describe('Given unfold without only, When formatting', () => {
    it('Then continuation lines collapse to one space and plain lines are kept', () => {
      // Arrange
      const options = { unfold: true };

      // Act
      const result = render(options);

      // Assert
      expect(result).toBe('Signed-off-by: A <a@b>\nnot trailer\nAcked-by: B\nFixes: one two\n');
    });
  });

  describe('Given a key filter, When formatting', () => {
    it('Then only the matching keys are printed, compared case-insensitively', () => {
      // Arrange
      const options = { onlyTrailers: true, keys: ['fixes'] };

      // Act
      const result = render(options);

      // Assert
      expect(result).toBe('Fixes: one\n  two\n');
    });

    it('Then several keys are alternatives', () => {
      // Arrange
      const options = { onlyTrailers: true, keys: ['fixes', 'ACKED-BY'] };

      // Act
      const result = render(options);

      // Assert
      expect(result).toBe('Acked-by: B\nFixes: one\n  two\n');
    });

    it('Then a key must match the whole token', () => {
      // Arrange
      const options = { onlyTrailers: true, keys: ['fix'] };

      // Act
      const result = render(options);

      // Assert
      expect(result).toBe('');
    });
  });

  describe('Given a configured token key, When formatting', () => {
    it('Then the trailer is printed and filtered under the configured key', () => {
      // Arrange
      const message = 'subject\n\none\ntwo\nthree\nAck: me\n';
      const config = { keys: new Map([['ack', 'Acked-by']]) };

      // Act
      const printed = render({ onlyTrailers: true }, config, message);
      const filtered = render({ onlyTrailers: true, keys: ['acked-by'] }, config, message);

      // Assert
      expect(printed).toBe('Acked-by: me\n');
      expect(filtered).toBe('Acked-by: me\n');
    });
  });

  describe('Given a separator, When formatting', () => {
    it('Then items are joined by it with no trailing line feed', () => {
      // Arrange
      const options = { separator: ', ' };

      // Act
      const result = render(options);

      // Assert
      expect(result).toBe('Signed-off-by: A <a@b>, not trailer, Acked-by: B, Fixes: one\n  two');
    });

    it('Then an empty separator still suppresses the line feed', () => {
      // Arrange
      const options = { onlyTrailers: true, separator: '' };

      // Act
      const result = render(options);

      // Assert
      expect(result).toBe('Signed-off-by: A <a@b>Acked-by: BFixes: one\n  two');
    });
  });

  describe('Given a key value separator, When formatting', () => {
    it('Then it replaces the default colon and space', () => {
      // Arrange
      const options = { keyValueSeparator: '=' };

      // Act
      const result = render(options);

      // Assert
      expect(result).toBe('Signed-off-by=A <a@b>\nnot trailer\nAcked-by=B\nFixes=one\n  two\n');
    });
  });

  describe('Given valueonly or keyonly, When formatting', () => {
    it('Then valueonly prints values and plain lines', () => {
      // Arrange
      const options = { valueOnly: true };

      // Act
      const result = render(options);

      // Assert
      expect(result).toBe('A <a@b>\nnot trailer\nB\none\n  two\n');
    });

    it('Then keyonly prints keys and plain lines', () => {
      // Arrange
      const options = { keyOnly: true };

      // Act
      const result = render(options);

      // Assert
      expect(result).toBe('Signed-off-by\nnot trailer\nAcked-by\nFixes\n');
    });

    it('Then both together print an empty line per trailer', () => {
      // Arrange
      const options = { onlyTrailers: true, keyOnly: true, valueOnly: true };

      // Act
      const result = render(options);

      // Assert
      expect(result).toBe('\n\n\n');
    });
  });

  describe('Given a token whose last character is not a separator, When formatting', () => {
    it('Then the first separator and a space are written after it', () => {
      // Arrange
      const message = 'subject\n\nBug #43\nFixes=1\n';
      const config = { separators: '#=' };

      // Act
      const result = render({ onlyTrailers: true }, config, message);

      // Assert
      expect(result).toBe('Bug# 43\nFixes# 1\n');
    });
  });

  describe('Given a message whose trailer block is followed by a Conflicts list, When formatting', () => {
    it('Then the list is ignored', () => {
      // Arrange
      const message = 'subject\n\nFixes: 1\nConflicts:\n\tfoo\n';

      // Act
      const result = block(message);

      // Assert
      expect(result).toBe('Fixes: 1\n');
    });
  });

  describe('Given unfold, When formatting lines the block holds', () => {
    it.each([
      [
        'an indented line holding a separator after a plain line stays plain',
        'subject\n\nSigned-off-by: A\nplain\n :x\n',
        'Signed-off-by: A\nplain\n :x\n',
      ],
      [
        'an indented first line stays plain',
        'subject\n\n x\nSigned-off-by: A\n',
        ' x\nSigned-off-by: A\n',
      ],
      [
        'a comment line is dropped without swallowing the indented line below it',
        'subject\n\nSigned-off-by: A\n# c\n x\n',
        'Signed-off-by: A\n x\n',
      ],
      ['a one-character token takes its continuation', 'subject\n\nA: x\n cont\n', 'A: x cont\n'],
      ['a token without letters or digits is kept', 'subject\n\n-: x\n', '-: x\n'],
    ])('Then %s', (_label, message, expected) => {
      // Arrange
      const options = { unfold: true };

      // Act
      const result = render(options, {}, message);

      // Assert
      expect(result).toBe(expected);
    });
  });

  describe('Given configured keys, When unfolding a trailer', () => {
    it.each([
      [
        'a token without letters or digits takes the first configured key',
        'ab',
        'Ab',
        '-: x\n',
        'Ab: x\n',
      ],
      ['an unrelated token is kept', 'ack', 'Acked-by', 'Fixes: 1\n', 'Fixes: 1\n'],
      [
        'a token prefixing the configured name takes its key',
        'fixes',
        'Fixes',
        'Fix: x\n',
        'Fixes: x\n',
      ],
      ['a trailing dash is ignored when matching', 'fix', 'Fixes', 'Fix-: x\n', 'Fixes: x\n'],
      [
        'a token matching only the key takes the key as configured',
        'ack',
        'Acked-by',
        'acked-by: x\n',
        'Acked-by: x\n',
      ],
    ])('Then %s', (_label, name, key, trailer, expected) => {
      // Arrange
      const config = { keys: new Map([[name, key]]) };

      // Act
      const result = render({ unfold: true }, config, `subject\n\n${trailer}`);

      // Assert
      expect(result).toBe(expected);
    });
  });

  describe('Given a key filter without only, When formatting', () => {
    it('Then the other trailers are dropped', () => {
      // Arrange
      const options = { keys: ['Fixes'] };

      // Act
      const result = render(options, {}, 'subject\n\nFixes: 1\nOther: 2\n');

      // Assert
      expect(result).toBe('Fixes: 1\n');
    });
  });
});

const parse = (placeholder: string, at = 0) => {
  const sut = parseTrailersPlaceholder;
  return sut(encode(placeholder), at);
};

describe('parseTrailersPlaceholder', () => {
  describe('Given a bare placeholder, When parsing', () => {
    it('Then the default options consume the whole placeholder', () => {
      // Arrange
      const placeholder = '(trailers)';

      // Act
      const result = parse(placeholder);

      // Assert
      expect(result).toEqual({ options: DEFAULT_TRAILER_OPTIONS, length: 10 });
    });
  });

  describe('Given a placeholder inside a longer format, When parsing', () => {
    it('Then it reads from the offset and stops at the closing parenthesis', () => {
      // Arrange
      const placeholder = 'ab(trailers:only)cd';

      // Act
      const result = parse(placeholder, 2);

      // Assert
      expect(result).toEqual({
        options: { ...DEFAULT_TRAILER_OPTIONS, onlyTrailers: true },
        length: 15,
      });
    });
  });

  describe('Given an empty option list, When parsing', () => {
    it('Then the defaults apply', () => {
      // Arrange
      const placeholder = '(trailers:)';

      // Act
      const result = parse(placeholder);

      // Assert
      expect(result).toEqual({ options: DEFAULT_TRAILER_OPTIONS, length: 11 });
    });
  });

  describe('Given boolean options, When parsing', () => {
    it('Then each bare name turns its flag on', () => {
      // Arrange
      const placeholder = '(trailers:only,unfold,keyonly,valueonly)';

      // Act
      const result = parse(placeholder);

      // Assert
      expect(result?.options).toEqual({
        ...DEFAULT_TRAILER_OPTIONS,
        onlyTrailers: true,
        unfold: true,
        keyOnly: true,
        valueOnly: true,
      });
    });

    it('Then a boolean value turns it off or on', () => {
      // Arrange
      const placeholder = '(trailers:only=no,unfold=yes,keyonly=0,valueonly=1)';

      // Act
      const result = parse(placeholder);

      // Assert
      expect(result?.options).toEqual({
        ...DEFAULT_TRAILER_OPTIONS,
        unfold: true,
        valueOnly: true,
      });
    });

    it('Then false, off, an empty value and zero units are false', () => {
      // Arrange
      const placeholder = '(trailers:only=FALSE,unfold=off,keyonly=,valueonly=0k)';

      // Act
      const result = parse(placeholder);

      // Assert
      expect(result?.options).toEqual(DEFAULT_TRAILER_OPTIONS);
    });

    it('Then a false value overrides an earlier bare name', () => {
      // Arrange
      const placeholder = '(trailers:only,only=no)';

      // Act
      const result = parse(placeholder);

      // Assert
      expect(result).toEqual({ options: DEFAULT_TRAILER_OPTIONS, length: 23 });
    });

    it('Then an unparsable value is skipped, leaving the next option to read from there', () => {
      // Arrange
      const placeholder = '(trailers:only=x,unfold)';

      // Act
      const result = parse(placeholder);

      // Assert
      expect(result?.options).toEqual({ ...DEFAULT_TRAILER_OPTIONS, unfold: true });
    });
  });

  describe('Given key options, When parsing', () => {
    it('Then keys accumulate, lose one trailing colon and imply only', () => {
      // Arrange
      const placeholder = '(trailers:key=Signed-off-by:,key=Fixes)';

      // Act
      const result = parse(placeholder);

      // Assert
      expect(result?.options).toEqual({
        ...DEFAULT_TRAILER_OPTIONS,
        onlyTrailers: true,
        keys: ['Signed-off-by', 'Fixes'],
      });
    });

    it('Then a key without a value is refused', () => {
      // Arrange
      const placeholder = '(trailers:key)';

      // Act
      const result = parse(placeholder);

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('Given separator options, When parsing', () => {
    it('Then separator expands %n, %xNN and %%', () => {
      // Arrange
      const placeholder = '(trailers:separator=%x2c%n%%)';

      // Act
      const result = parse(placeholder);

      // Assert
      expect(result?.options.separator).toBe(',\n%');
    });

    it('Then a lone percent and an unknown escape stay literal', () => {
      // Arrange
      const placeholder = '(trailers:key_value_separator=%q%x2z%)';

      // Act
      const result = parse(placeholder);

      // Assert
      expect(result?.options.keyValueSeparator).toBe('%q%x2z%');
    });

    it('Then an empty separator is kept distinct from none', () => {
      // Arrange
      const placeholder = '(trailers:separator=)';

      // Act
      const result = parse(placeholder);

      // Assert
      expect(result?.options.separator).toBe('');
    });

    it('Then a separator name without a value is the empty separator', () => {
      // Arrange
      const placeholder = '(trailers:separator,key_value_separator)';

      // Act
      const result = parse(placeholder);

      // Assert
      expect(result?.options.separator).toBe('');
      expect(result?.options.keyValueSeparator).toBe('');
    });
  });

  describe('Given malformed placeholders, When parsing', () => {
    it.each([
      ['an unknown option', '(trailers:bogus)'],
      ['a name that only extends trailers', '(trailersx)'],
      ['a missing closing parenthesis', '(trailers:only'],
      ['a trailing comma list end', '(trailers:only,'],
      ['a non-trailers placeholder', '(describe)'],
      ['an unterminated valued option', '(trailers:separator=abc'],
      ['a valued option cut before its terminator', '(trailers:only=1x'],
    ])('Then %s is not a trailers placeholder', (_label, placeholder) => {
      // Arrange
      const format = placeholder;

      // Act
      const result = parse(format);

      // Assert
      expect(result).toBeUndefined();
    });
  });
});
