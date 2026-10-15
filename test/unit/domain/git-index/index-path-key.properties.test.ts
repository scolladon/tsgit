import fc from 'fast-check';
import { describe, it } from 'vitest';
import {
  indexPathKey,
  indexPathOfBytes,
  pathBytesOf,
  splitAtSlash,
} from '../../../../src/domain/git-index/index-path-key.js';
import {
  bytesEqual,
  concatBytes,
  decodePreservingBom,
  encode,
} from '../../../../src/domain/objects/encoding.js';
import { arbPathBytes } from './arbitraries.js';

const SLASH = Uint8Array.of(0x2f);

const joinWithSlash = (parts: ReadonlyArray<Uint8Array>): Uint8Array =>
  concatBytes(parts.flatMap((part, i) => (i === 0 ? [part] : [SLASH, part])));

describe('index path key properties', () => {
  describe('Given arbitrary path bytes', () => {
    describe('When building the path and reading its bytes back', () => {
      it('Then the bytes round-trip', () => {
        // Arrange
        const property = fc.property(arbPathBytes(), (bytes) =>
          bytesEqual(pathBytesOf(indexPathOfBytes(bytes)), bytes),
        );

        // Act & Assert
        fc.assert(property, { numRuns: 200 });
      });
    });

    describe('When checking whether pathBytes is present', () => {
      it('Then it is absent exactly when the view re-encodes to the bytes', () => {
        // Arrange
        const property = fc.property(
          arbPathBytes(),
          (bytes) =>
            (indexPathOfBytes(bytes).pathBytes === undefined) ===
            bytesEqual(encode(decodePreservingBom(bytes)), bytes),
        );

        // Act & Assert
        fc.assert(property, { numRuns: 100 });
      });
    });

    describe('When splitting at slashes and re-joining', () => {
      it('Then the original bytes come back', () => {
        // Arrange
        const property = fc.property(arbPathBytes(), (bytes) =>
          bytesEqual(joinWithSlash(splitAtSlash(bytes)), bytes),
        );

        // Act & Assert
        fc.assert(property, { numRuns: 200 });
      });
    });
  });

  describe('Given two arbitrary path bytes', () => {
    describe('When keying both', () => {
      it('Then the keys are equal exactly when the bytes are', () => {
        // Arrange
        const property = fc.property(
          arbPathBytes(),
          arbPathBytes(),
          (b1, b2) =>
            (indexPathKey(indexPathOfBytes(b1)) === indexPathKey(indexPathOfBytes(b2))) ===
            bytesEqual(b1, b2),
        );

        // Act & Assert
        fc.assert(property, { numRuns: 100 });
      });
    });
  });
});
