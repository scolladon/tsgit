import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  escapedPathOf,
  indexPathKey,
  indexPathOfBytes,
  indexPathOfEscaped,
  pathBytesOf,
  splitAtSlash,
  viewOfEscaped,
} from '../../../../src/domain/git-index/index-path-key.js';
import {
  bytesEqual,
  concatBytes,
  decodePreservingBom,
  encode,
} from '../../../../src/domain/objects/encoding.js';
import { arbIndexEntryWithPathBytes, arbPathBytes } from './arbitraries.js';

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

  describe('Given an arbitrary entry', () => {
    describe('When escaping its path and building the index path back', () => {
      it('Then path and pathBytes are restored', () => {
        // Arrange
        const property = fc.property(arbIndexEntryWithPathBytes(), (entry) => {
          const result = indexPathOfEscaped(escapedPathOf(entry));
          expect(result).toStrictEqual({
            path: entry.path,
            ...(entry.pathBytes && { pathBytes: entry.pathBytes }),
          });
        });

        // Act & Assert
        fc.assert(property, { numRuns: 100 });
      });
    });
  });

  describe('Given two arbitrary path bytes', () => {
    describe('When escaping both', () => {
      it('Then the escaped paths are equal exactly when the bytes are', () => {
        // Arrange
        const property = fc.property(
          arbPathBytes(),
          arbPathBytes(),
          (b1, b2) =>
            (escapedPathOf(indexPathOfBytes(b1)) === escapedPathOf(indexPathOfBytes(b2))) ===
            bytesEqual(b1, b2),
        );

        // Act & Assert
        fc.assert(property, { numRuns: 100 });
      });
    });
  });

  describe('Given arbitrary path bytes', () => {
    describe('When viewing their escaped path', () => {
      it('Then it is the entry path', () => {
        // Arrange
        const property = fc.property(arbPathBytes(), (bytes) => {
          const entry = indexPathOfBytes(bytes);
          return viewOfEscaped(escapedPathOf(entry)) === entry.path;
        });

        // Act & Assert
        fc.assert(property, { numRuns: 200 });
      });
    });
  });
});
