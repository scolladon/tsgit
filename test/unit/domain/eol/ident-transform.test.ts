import { describe, expect, it } from 'vitest';

import { createIdentTransform } from '../../../../src/domain/eol/ident-transform.js';

const OID = '08a4620a27060eb3dbee93734f82d9146bfd1b4d';
const DIVERGENCE_BLOB = '$$Id$\n$Id:a b$\n$Id: a\tb $\n$Id$Id$\n';
const DIVERGENCE_STREAMED = `$$Id$\n$Id: ${OID} $\n$Id: a\tb $\n$Id: ${OID} $Id$\n`;

const bytes = (value: string): Uint8Array =>
  Uint8Array.from([...value].map((c) => c.charCodeAt(0)));

const text = (chunks: ReadonlyArray<Uint8Array>): string =>
  chunks.map((chunk) => String.fromCharCode(...chunk)).join('');

const run = (chunks: ReadonlyArray<string>): string => {
  const sut = createIdentTransform(OID);
  const pushed = chunks.flatMap((chunk) => sut.push(bytes(chunk)));
  return text(pushed) + text(sut.flush());
};

const splitEveryByte = (value: string): ReadonlyArray<string> => [...value];

describe('createIdentTransform', () => {
  describe('Given the divergence blob', () => {
    describe('When pushed in one chunk', () => {
      it('Then the streamed expander output is produced', () => {
        // Arrange
        const input = [DIVERGENCE_BLOB];

        // Act
        const result = run(input);

        // Assert
        expect(result).toBe(DIVERGENCE_STREAMED);
      });
    });

    describe('When pushed one byte at a time', () => {
      it('Then the output equals the unchunked output', () => {
        // Arrange
        const input = splitEveryByte(DIVERGENCE_BLOB);

        // Act
        const result = run(input);

        // Assert
        expect(result).toBe(DIVERGENCE_STREAMED);
      });
    });
  });

  describe.each([
    ['a bare keyword', 'x $Id$ y', `x $Id: ${OID} $ y`],
    ['a valued keyword', '$Id: deadbeef $', `$Id: ${OID} $`],
    ['a keyword with no space after the colon', '$Id:a b$', `$Id: ${OID} $`],
    ['a keyword with an empty value', '$Id:$', `$Id: ${OID} $`],
    ['a space-only value', '$Id: $', `$Id: ${OID} $`],
    ['a foreign keyword with an inner space', '$Id: has space x $', '$Id: has space x $'],
    ['a foreign keyword with an inner tab', '$Id: a\tb $', '$Id: a\tb $'],
    ['a foreign keyword with an inner CR', '$Id: a\rb $', '$Id: a\rb $'],
    ['a foreign keyword with an inner VT', '$Id: a\vb $', '$Id: a\vb $'],
    ['a foreign keyword with an inner FF', '$Id: a\fb $', '$Id: a\fb $'],
    ['a keyword split by a LF', '$Id: nl\n$ $Id$', `$Id: nl\n$ $Id: ${OID} $`],
    ['a keyword name followed by another byte', '$Idx$', '$Idx$'],
    ['a name with a wrong second letter', '$Ix$Id$', `$Ix$Id: ${OID} $`],
    ['a name with a wrong third letter', '$Ix', '$Ix'],
    ['no dollar', 'plain text\n', 'plain text\n'],
  ])('Given %s', (_title, input, expected) => {
    describe('When pushed whole', () => {
      it('Then the streamed output matches', () => {
        // Arrange
        const chunks = [input];

        // Act
        const result = run(chunks);

        // Assert
        expect(result).toBe(expected);
      });
    });

    describe('When pushed one byte at a time', () => {
      it('Then the output is identical', () => {
        // Arrange
        const chunks = splitEveryByte(input);

        // Act
        const result = run(chunks);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe.each([
    ['a lone dollar', '$'],
    ['a dollar and I', '$I'],
    ['the name without a terminator', '$Id'],
    ['an unterminated colon keyword', '$Id: abc'],
  ])('Given input ending in %s', (_title, input) => {
    describe('When flushed', () => {
      it('Then the pending bytes are emitted verbatim', () => {
        // Arrange
        const sut = createIdentTransform(OID);

        // Act
        const pushed = sut.push(bytes(input));
        const flushed = sut.flush();

        // Assert
        expect(text(pushed)).toBe('');
        expect(text(flushed)).toBe(input);
      });
    });
  });

  describe('Given a flush that emitted pending bytes', () => {
    describe('When more input follows', () => {
      it('Then the transform starts clean', () => {
        // Arrange
        const sut = createIdentTransform(OID);
        sut.push(bytes('$Id: abc'));
        sut.flush();

        // Act
        const result = sut.push(bytes('x$Id$'));

        // Assert
        expect(text(result)).toBe(`x$Id: ${OID} $`);
      });
    });
  });

  describe('Given a chunk without any dollar', () => {
    describe('When pushed', () => {
      it('Then the very same chunk is returned', () => {
        // Arrange
        const sut = createIdentTransform(OID);
        const chunk = bytes('plain');

        // Act
        const result = sut.push(chunk);

        // Assert
        expect(result).toEqual([chunk]);
        expect(result[0]).toBe(chunk);
      });
    });
  });

  describe('Given an empty chunk', () => {
    describe('When pushed', () => {
      it('Then nothing is emitted', () => {
        // Arrange
        const sut = createIdentTransform(OID);

        // Act
        const result = sut.push(new Uint8Array(0));

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a 64-hex object id', () => {
    describe('When a bare keyword is pushed', () => {
      it('Then the keyword carries the full width', () => {
        // Arrange
        const wide = 'a'.repeat(64);
        const sut = createIdentTransform(wide);

        // Act
        const result = sut.push(bytes('$Id$'));

        // Assert
        expect(text(result)).toBe(`$Id: ${wide} $`);
      });
    });
  });
});
