import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseBlobContent, serializeBlobContent } from '../../../../src/domain/objects/blob.js';
import { ObjectId } from '../../../../src/domain/objects/object-id.js';

const DUMMY_ID = ObjectId.from('a'.repeat(40));

describe('blob', () => {
  describe('parseBlobContent', () => {
    it('Given raw content bytes, When parsing blob, Then content shares the same ArrayBuffer (zero-copy)', () => {
      // Arrange
      const source = new Uint8Array([1, 2, 3]);

      // Act
      const sut = parseBlobContent(DUMMY_ID, source);

      // Assert
      expect(sut.content.buffer).toBe(source.buffer);
    });

    it('Given empty content (0 bytes), When parsing blob, Then blob.content.length is 0', () => {
      // Arrange
      const source = new Uint8Array(0);

      // Act
      const sut = parseBlobContent(DUMMY_ID, source);

      // Assert
      expect(sut.content.length).toBe(0);
    });

    it('Given binary content (all 256 byte values), When parsing blob, Then all bytes preserved', () => {
      // Arrange
      const source = new Uint8Array(256);
      for (let i = 0; i < 256; i++) source[i] = i;

      // Act
      const sut = parseBlobContent(DUMMY_ID, source);

      // Assert
      expect(sut.content).toEqual(source);
    });
  });

  describe('serializeBlobContent', () => {
    it('Given a blob, When serializing, Then returns byte-identical content', () => {
      // Arrange
      const content = new Uint8Array([10, 20, 30]);
      const blob = parseBlobContent(DUMMY_ID, content);

      // Act
      const sut = serializeBlobContent(blob);

      // Assert
      expect(sut).toEqual(content);
    });
  });

  describe('roundtrip', () => {
    it('Given a blob, When roundtripping parse(serialize(blob)), Then content is byte-identical', () => {
      // Arrange
      const content = new Uint8Array([0xff, 0x00, 0xab, 0xcd]);
      const blob = parseBlobContent(DUMMY_ID, content);

      // Act
      const sut = parseBlobContent(DUMMY_ID, serializeBlobContent(blob));

      // Assert
      expect(sut.content).toEqual(content);
    });
  });

  describe('property-based tests', () => {
    it('Given the roundtrip property "parseBlobContent(id, serializeBlobContent(blob)).content equals original content", When sampled, Then it holds', () => {
      // Arrange
      // Assert
      fc.assert(
        fc.property(fc.uint8Array({ minLength: 0, maxLength: 10000 }), (content) => {
          const blob = parseBlobContent(DUMMY_ID, content);
          const sut = parseBlobContent(DUMMY_ID, serializeBlobContent(blob));
          expect(sut.content).toEqual(content);
        }),
      );
    });
  });
});
