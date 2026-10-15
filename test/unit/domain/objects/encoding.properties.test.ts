import fc from 'fast-check';
import { describe, it } from 'vitest';

import {
  bytesEqual,
  decodeEscapingInvalid,
  encode,
  encodeEscaped,
  hasEscapedBytes,
} from '../../../../src/domain/objects/encoding.js';

const ASCII_MAX = 0x7f;

const arbBytes = (): fc.Arbitrary<Uint8Array> => fc.uint8Array({ maxLength: 12 });
const arbWellFormed = (): fc.Arbitrary<string> => fc.string({ unit: 'grapheme' });

describe('surrogate-escape codec properties', () => {
  describe('Given arbitrary bytes', () => {
    describe('When decoding with escapes then encoding back', () => {
      it('Then the original bytes come back', () => {
        // Arrange
        const property = fc.property(arbBytes(), (bytes) =>
          bytesEqual(encodeEscaped(decodeEscapingInvalid(bytes)), bytes),
        );

        // Act & Assert
        fc.assert(property, { numRuns: 200 });
      });
    });

    describe('When decoding with escapes', () => {
      it('Then every ascii byte keeps the code-unit offset of its prefix', () => {
        // Arrange
        const property = fc.property(arbBytes(), (bytes) =>
          bytes.every(
            (byte, i) =>
              byte > ASCII_MAX ||
              decodeEscapingInvalid(bytes).charCodeAt(
                decodeEscapingInvalid(bytes.subarray(0, i)).length,
              ) === byte,
          ),
        );

        // Act & Assert
        fc.assert(property, { numRuns: 100 });
      });
    });
  });

  describe('Given an arbitrary well-formed string', () => {
    describe('When encoding and decoding with escapes', () => {
      it('Then it has no escape and both directions are plain UTF-8', () => {
        // Arrange
        const property = fc.property(
          arbWellFormed(),
          (text) =>
            !hasEscapedBytes(text) &&
            decodeEscapingInvalid(encode(text)) === text &&
            bytesEqual(encodeEscaped(text), encode(text)),
        );

        // Act & Assert
        fc.assert(property, { numRuns: 200 });
      });
    });
  });
});
