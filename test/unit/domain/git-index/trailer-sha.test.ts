import { describe, expect, it } from 'vitest';
import { parseIndex } from '../../../../src/domain/git-index/index-parser.js';

const DIRC_HEADER = new Uint8Array([
  // signature: 'DIRC'
  0x44, 0x49, 0x52, 0x43,
  // version: 2
  0x00, 0x00, 0x00, 0x02,
  // entry count: 0
  0x00, 0x00, 0x00, 0x00,
]);

const TRAILER_BYTES = new Uint8Array([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
  0x11, 0x12, 0x13, 0x14,
]);

function buildMinimalIndex(trailer: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(DIRC_HEADER.length + trailer.length);
  bytes.set(DIRC_HEADER, 0);
  bytes.set(trailer, DIRC_HEADER.length);
  return bytes;
}

describe('parseIndex trailerSha', () => {
  describe('Given a minimal valid index buffer with a known 20-byte trailer', () => {
    describe('When parseIndex is called', () => {
      it('Then the returned GitIndex exposes the trailing 20 bytes as trailerSha', () => {
        // Arrange
        const bytes = buildMinimalIndex(TRAILER_BYTES);

        // Act
        const sut = parseIndex(bytes);

        // Assert
        expect(sut.trailerSha).toEqual(TRAILER_BYTES);
      });

      it('Then trailerSha is the last 20 bytes of the input buffer', () => {
        // Arrange
        const bytes = buildMinimalIndex(TRAILER_BYTES);

        // Act
        const sut = parseIndex(bytes);

        // Assert
        expect(sut.trailerSha).toEqual(bytes.slice(bytes.length - 20));
      });
    });
  });

  describe('Given two valid indexes with different trailing bytes', () => {
    describe('When parseIndex is called on each', () => {
      it('Then their trailerSha fields are byte-distinct', () => {
        // Arrange
        const trailerA = new Uint8Array(20).fill(0xaa);
        const trailerB = new Uint8Array(20).fill(0xbb);
        const indexA = buildMinimalIndex(trailerA);
        const indexB = buildMinimalIndex(trailerB);

        // Act
        const sutA = parseIndex(indexA);
        const sutB = parseIndex(indexB);

        // Assert
        expect(sutA.trailerSha).toEqual(trailerA);
        expect(sutB.trailerSha).toEqual(trailerB);
        expect(sutA.trailerSha).not.toEqual(sutB.trailerSha);
      });
    });
  });

  describe('Given the trailer is captured before the GitIndex is returned', () => {
    describe('When the caller mutates the source buffer', () => {
      it('Then the returned trailerSha is unaffected (slice copies bytes)', () => {
        // Arrange
        const bytes = buildMinimalIndex(TRAILER_BYTES);

        // Act
        const sut = parseIndex(bytes);
        bytes.set(new Uint8Array(20).fill(0xff), bytes.length - 20);

        // Assert
        expect(sut.trailerSha).toEqual(TRAILER_BYTES);
      });
    });
  });
});
