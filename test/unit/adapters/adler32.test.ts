import { describe, expect, it } from 'vitest';
import { adler32 } from '../../../src/adapters/adler32.js';

describe('adler32', () => {
  describe('Given a buffer with a known adler32 checksum', () => {
    describe('When adler32 is called', () => {
      it.each([
        {
          input: new Uint8Array([]),
          expected: 1,
          label: 'an empty buffer returns 1 (RFC 1950 initial value)',
        },
        {
          input: new Uint8Array([1]),
          expected: 131074,
          // a = (1+1)%65521 = 2, b = (0+2)%65521 = 2 → (2<<16)|2 = 131074
          label: 'a single-byte buffer [1] returns 131074 (a=2, b=2)',
        },
        {
          input: new TextEncoder().encode('Wikipedia'),
          expected: 0x11e60398,
          label: 'the ASCII string "Wikipedia" returns 0x11E60398 (RFC 1950 reference vector)',
        },
      ])('Then $label', ({ input, expected }) => {
        // Arrange
        const sut = adler32;

        // Act
        const result = sut(input);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given a zlib-deflated buffer produced by MemoryCompressor', () => {
    describe('When adler32 is called on the decompressed payload', () => {
      it('Then matches the last 4 big-endian bytes of the zlib stream', async () => {
        // Arrange
        // MemoryCompressor.deflate produces a RFC 1950 zlib stream; its last
        // 4 bytes are the big-endian adler32 of the uncompressed content.
        const { MemoryCompressor } = await import(
          '../../../src/adapters/memory/memory-compressor.js'
        );
        const compressor = new MemoryCompressor();
        const payload = new Uint8Array([10, 20, 30, 40, 50]);
        const sut = adler32;

        // Act
        const compressed = await compressor.deflate(payload);
        const trailerView = new DataView(compressed.buffer, compressed.byteLength - 4, 4);
        const storedChecksum = trailerView.getUint32(0);
        const computedChecksum = sut(payload);

        // Assert
        expect(computedChecksum).toBe(storedChecksum);
      });
    });
  });
});
