import { describe, expect, it } from 'vitest';

import { parseAlternatesFile, unquoteCStyle } from '../../../../src/domain/storage/alternates.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const texts = (entries: ReadonlyArray<Uint8Array>): string[] =>
  entries.map((entry) => new TextDecoder().decode(entry));

describe('parseAlternatesFile', () => {
  describe('Given a file with a comment, blank lines and plain entries', () => {
    describe('When parsing', () => {
      it('Then the entries come in file order without trimming', () => {
        // Arrange
        const sut = parseAlternatesFile;

        // Act
        const result = sut(bytes('# c\n\n   \n  # indented\n/abs/objects\n'));

        // Assert
        expect(texts(result)).toEqual(['   ', '  # indented', '/abs/objects']);
      });
    });
  });

  describe('Given a quoted entry whose escape is followed by bytes below the octal digits', () => {
    describe('When parsing', () => {
      it('Then the broken quoting leaves the line verbatim', () => {
        // Arrange
        const sut = parseAlternatesFile;

        // Act
        const result = sut(bytes('"\\///"\n'));

        // Assert
        expect(texts(result)).toEqual(['"\\///"']);
      });
    });
  });

  describe('Given an empty file', () => {
    describe('When parsing', () => {
      it('Then there are no entries', () => {
        // Arrange
        const sut = parseAlternatesFile;

        // Act
        const result = sut(new Uint8Array(0));

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given an entry without a final newline', () => {
    describe('When parsing', () => {
      it('Then the entry is kept', () => {
        // Arrange
        const sut = parseAlternatesFile;

        // Act
        const result = sut(bytes('/abs/objects'));

        // Assert
        expect(texts(result)).toEqual(['/abs/objects']);
      });
    });
  });

  describe('Given CRLF and trailing-space entries', () => {
    describe('When parsing', () => {
      it('Then the carriage return and the space are kept', () => {
        // Arrange
        const sut = parseAlternatesFile;

        // Act
        const result = sut(bytes('/a\r\n/b \n'));

        // Assert
        expect(texts(result)).toEqual(['/a\r', '/b ']);
      });
    });
  });

  describe('Given a comment with no terminating newline', () => {
    describe('When parsing', () => {
      it('Then it is dropped', () => {
        // Arrange
        const sut = parseAlternatesFile;

        // Act
        const result = sut(bytes('/a\n# tail'));

        // Assert
        expect(texts(result)).toEqual(['/a']);
      });
    });
  });

  describe('Given a file made only of newlines', () => {
    describe('When parsing', () => {
      it('Then empty entries are skipped', () => {
        // Arrange
        const sut = parseAlternatesFile;

        // Act
        const result = sut(bytes('\n\n\n'));

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given C-quoted entries', () => {
    describe('When parsing', () => {
      it.each([
        { label: 'newline escape', file: '"/nl\\nx/o"\n', expected: '/nl\nx/o' },
        { label: 'octal space', file: '"/sp\\040ace/o"\n', expected: '/sp ace/o' },
        { label: 'octal utf-8', file: '"/\\303\\251/o"\n', expected: '/é/o' },
        { label: 'raw newline inside quotes', file: '"/x\ny/o"\n', expected: '/x\ny/o' },
        {
          label: 'quoted relative',
          file: '"../../a.git/objects"\n',
          expected: '../../a.git/objects',
        },
      ])('Then the unquoted bytes ($label)', ({ file, expected }) => {
        // Arrange
        const sut = parseAlternatesFile;

        // Act
        const result = sut(bytes(file));

        // Assert
        expect(texts(result)).toEqual([expected]);
      });
    });
  });

  describe('Given broken quoting', () => {
    describe('When parsing', () => {
      it.each([
        { label: 'no closing quote', file: '"/abs/objects\n', expected: '"/abs/objects' },
        { label: 'bad escape', file: '"/a/x\\q/o"\n', expected: '"/a/x\\q/o"' },
      ])('Then the whole line is taken verbatim ($label)', ({ file, expected }) => {
        // Arrange
        const sut = parseAlternatesFile;

        // Act
        const result = sut(bytes(file));

        // Assert
        expect(texts(result)).toEqual([expected]);
      });
    });
  });

  describe('Given a byte after a closing quote', () => {
    describe('When parsing', () => {
      it('Then exactly that one byte is skipped whatever it is', () => {
        // Arrange
        const sut = parseAlternatesFile;

        // Act
        const result = sut(bytes('"/abs" trailing\n'));

        // Assert
        expect(texts(result)).toEqual(['/abs', 'trailing']);
      });

      it('Then a closing quote at the very end of the file is accepted', () => {
        // Arrange
        const sut = parseAlternatesFile;

        // Act
        const result = sut(bytes('"/abs"'));

        // Assert
        expect(texts(result)).toEqual(['/abs']);
      });
    });
  });

  describe('Given a NUL byte', () => {
    describe('When parsing', () => {
      it('Then scanning stops there', () => {
        // Arrange
        const sut = parseAlternatesFile;

        // Act
        const result = sut(bytes('/a\n\0/b\n'));

        // Assert
        expect(texts(result)).toEqual(['/a']);
      });

      it('Then a NUL inside a quoted span breaks the quoting', () => {
        // Arrange
        const sut = parseAlternatesFile;

        // Act
        const result = sut(bytes('"/a\0b"\n'));

        // Assert
        expect(texts(result)).toEqual(['"/a']);
      });
    });
  });
});

describe('unquoteCStyle', () => {
  describe('Given a quoted span', () => {
    describe('When unquoting an escape', () => {
      it.each([
        { sequence: '\\a', byte: 0x07 },
        { sequence: '\\b', byte: 0x08 },
        { sequence: '\\f', byte: 0x0c },
        { sequence: '\\n', byte: 0x0a },
        { sequence: '\\r', byte: 0x0d },
        { sequence: '\\t', byte: 0x09 },
        { sequence: '\\v', byte: 0x0b },
        { sequence: '\\\\', byte: 0x5c },
        { sequence: '\\"', byte: 0x22 },
        { sequence: '\\101', byte: 0x41 },
        { sequence: '\\377', byte: 0xff },
        { sequence: '\\000', byte: 0x00 },
      ])('Then $sequence decodes to byte $byte', ({ sequence, byte }) => {
        // Arrange
        const sut = unquoteCStyle;
        const input = bytes(`"${sequence}"`);

        // Act
        const result = sut(input, 0);

        // Assert
        expect(result).toEqual({ value: new Uint8Array([byte]), end: input.length });
      });
    });

    describe('When the span starts after an offset', () => {
      it('Then end is the index after the closing quote', () => {
        // Arrange
        const sut = unquoteCStyle;

        // Act
        const result = sut(bytes('xx"ab"yy'), 2);

        // Assert
        expect(result).toEqual({ value: bytes('ab'), end: 6 });
      });
    });

    describe('When the quoting is broken', () => {
      it.each([
        { label: 'first octal digit 4', text: '"\\400"' },
        { label: 'short octal', text: '"\\10"' },
        { label: 'non-octal second digit', text: '"\\189"' },
        { label: 'non-octal third digit', text: '"\\108"' },
        { label: 'unknown escape', text: '"\\q"' },
        { label: 'unterminated', text: '"abc' },
        { label: 'only the opening quote', text: '"' },
        { label: 'trailing backslash', text: '"abc\\' },
      ])('Then it is undefined ($label)', ({ text }) => {
        // Arrange
        const sut = unquoteCStyle;

        // Act
        const result = sut(bytes(text), 0);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});
