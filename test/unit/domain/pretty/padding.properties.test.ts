import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Align, padValue } from '../../../../src/domain/pretty/padding.js';
import { utf8Width } from '../../../../src/domain/pretty/utf8-width.js';

const NUM_RUNS = 200;
const MAX_WIDTH = 64;
const ALIGNS: ReadonlyArray<Align> = ['text-left', 'text-right', 'centered'];

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const printable = fc.string({ unit: fc.constantFrom(...'aZ 9_日本語ト'), maxLength: 40 });

describe('padValue', () => {
  describe('Given an arbitrary value and width without truncation, When padding', () => {
    it('Then the body is as wide as the larger of the width and the value', () => {
      fc.assert(
        fc.property(
          printable,
          fc.integer({ min: 1, max: MAX_WIDTH }),
          fc.constantFrom(...ALIGNS),
          (text, width, align) => {
            // Arrange
            const sut = padValue;
            const value = encode(text);

            // Act
            const result = sut(
              new Uint8Array(),
              value,
              { width, fromColumn: false, align },
              'none',
            );

            // Assert
            expect(utf8Width(result.body)).toBe(Math.max(width, utf8Width(value)));
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it('Then the value survives whole inside the body', () => {
      fc.assert(
        fc.property(
          printable,
          fc.integer({ min: 1, max: MAX_WIDTH }),
          fc.constantFrom(...ALIGNS),
          (text, width, align) => {
            // Arrange
            const sut = padValue;

            // Act
            const result = sut(
              new Uint8Array(),
              encode(text),
              { width, fromColumn: false, align },
              'none',
            );

            // Assert
            expect(new TextDecoder().decode(result.body).trim()).toBe(text.trim());
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });
});
