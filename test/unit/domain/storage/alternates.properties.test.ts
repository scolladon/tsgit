import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseAlternatesFile } from '../../../../src/domain/storage/alternates.js';
import { arbAlternatesFileBytes, arbPlainAlternateLine, cQuote } from './arbitraries.js';

describe('parseAlternatesFile properties', () => {
  describe('Given arbitrary bytes', () => {
    describe('When parsing', () => {
      it('Then it never throws', () => {
        // Arrange
        const sut = parseAlternatesFile;

        fc.assert(
          fc.property(arbAlternatesFileBytes(), (input) => {
            // Act
            const result = sut(input);

            // Assert
            expect(Array.isArray(result)).toBe(true);
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given k plain column-0 lines', () => {
    describe('When parsing', () => {
      it('Then there are exactly k entries equal to the lines', () => {
        // Arrange
        const sut = parseAlternatesFile;

        fc.assert(
          fc.property(fc.array(arbPlainAlternateLine(), { maxLength: 8 }), (lines) => {
            const file = new TextEncoder().encode(lines.map((line) => `${line}\n`).join(''));

            // Act
            const result = sut(file);

            // Assert
            expect(result.map((entry) => new TextDecoder().decode(entry))).toEqual(lines);
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given a path without a newline', () => {
    describe('When parsing its C-quoted form', () => {
      it('Then the path comes back', () => {
        // Arrange
        const sut = parseAlternatesFile;

        fc.assert(
          fc.property(
            fc
              .uint8Array({ minLength: 1, maxLength: 24 })
              .filter((path) => !path.includes(0x0a) && !path.includes(0)),
            (path) => {
              const file = new Uint8Array([...cQuote(path), 0x0a]);

              // Act
              const result = sut(file);

              // Assert
              expect(result).toEqual([path]);
            },
          ),
          { numRuns: 200 },
        );
      });
    });
  });
});
