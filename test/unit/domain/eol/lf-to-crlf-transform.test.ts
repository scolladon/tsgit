import { describe, expect, it } from 'vitest';

import { createLfToCrlfTransform } from '../../../../src/domain/eol/lf-to-crlf-transform.js';

const bytes = (text: string): Uint8Array => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));

const text = (chunks: ReadonlyArray<Uint8Array>): string =>
  chunks.map((chunk) => String.fromCharCode(...chunk)).join('');

describe('createLfToCrlfTransform', () => {
  describe('Given a chunk ending in CR', () => {
    describe('When the next chunk starts with LF', () => {
      it('Then no extra CR is inserted', () => {
        // Arrange
        const sut = createLfToCrlfTransform();

        // Act
        const first = sut.push(bytes('a\r'));
        const second = sut.push(bytes('\nb'));

        // Assert
        expect(text(first) + text(second)).toBe('a\r\nb');
      });
    });
  });

  describe('Given a first chunk that starts with LF', () => {
    describe('When pushed', () => {
      it('Then a CR is inserted before it', () => {
        // Arrange
        const sut = createLfToCrlfTransform();

        // Act
        const result = sut.push(bytes('\na'));

        // Assert
        expect(text(result)).toBe('\r\na');
      });
    });
  });

  describe('Given a chunk ending in a non-CR byte', () => {
    describe('When the next chunk starts with LF', () => {
      it('Then a CR is inserted before it', () => {
        // Arrange
        const sut = createLfToCrlfTransform();

        // Act
        const first = sut.push(bytes('a'));
        const second = sut.push(bytes('\n'));

        // Assert
        expect(text(first) + text(second)).toBe('a\r\n');
      });
    });
  });

  describe('Given a CR followed by an empty chunk', () => {
    describe('When a chunk starting with LF follows', () => {
      it('Then the remembered CR survives the empty chunk', () => {
        // Arrange
        const sut = createLfToCrlfTransform();

        // Act
        const parts = [sut.push(bytes('\r')), sut.push(new Uint8Array(0)), sut.push(bytes('\n'))];

        // Assert
        expect(parts.map(text).join('')).toBe('\r\n');
      });
    });
  });

  describe('Given a chunk with CRLF and a lone LF', () => {
    describe('When pushed', () => {
      it('Then only the lone LF gains a CR', () => {
        // Arrange
        const sut = createLfToCrlfTransform();

        // Act
        const result = sut.push(bytes('a\r\nb\nc'));

        // Assert
        expect(text(result)).toBe('a\r\nb\r\nc');
      });
    });
  });

  describe('Given a chunk with no LF', () => {
    describe('When pushed', () => {
      it('Then the bytes pass through equal', () => {
        // Arrange
        const sut = createLfToCrlfTransform();

        // Act
        const result = sut.push(bytes('abc'));

        // Assert
        expect(result).toEqual([bytes('abc')]);
      });
    });
  });

  describe('Given an empty chunk', () => {
    describe('When pushed', () => {
      it('Then nothing is emitted', () => {
        // Arrange
        const sut = createLfToCrlfTransform();

        // Act
        const result = sut.push(new Uint8Array(0));

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a transform that received data', () => {
    describe('When flushed', () => {
      it('Then nothing is emitted', () => {
        // Arrange
        const sut = createLfToCrlfTransform();
        sut.push(bytes('a\r'));

        // Act
        const result = sut.flush();

        // Assert
        expect(result).toEqual([]);
      });
    });
  });
});
