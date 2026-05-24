import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';
import { computeLooseObjectPath } from '../../../../src/domain/storage/loose-path.js';
import { arbObjectId } from '../objects/arbitraries.js';

describe('loose-path', () => {
  describe('computeLooseObjectPath', () => {
    it("Given a SHA-1 ObjectId 'aabb...', When computing path, Then returns 'aa/bb...'", () => {
      // Arrange
      const sut = ('aa' + 'bb'.repeat(19)) as ObjectId;

      // Act
      const result = computeLooseObjectPath(sut);

      // Assert
      expect(result).toBe('aa/' + 'bb'.repeat(19));
    });

    it("Given a SHA-256 ObjectId (64 chars), When computing path, Then returns 'xx/yy...'", () => {
      // Arrange
      const sut = ('cc' + 'dd'.repeat(31)) as ObjectId;

      // Act
      const result = computeLooseObjectPath(sut);

      // Assert
      expect(result).toBe('cc/' + 'dd'.repeat(31));
    });

    it('Given any ObjectId, When computing path, Then first segment is 2 chars', () => {
      // Arrange
      const sut = ('abcdef0123456789' + '0'.repeat(24)) as ObjectId;

      // Act
      const result = computeLooseObjectPath(sut);

      // Assert
      expect(result.split('/')[0]).toHaveLength(2);
    });

    it('Given any ObjectId, When computing path, Then second segment is remaining chars', () => {
      // Arrange
      const id = ('abcdef0123456789' + '0'.repeat(24)) as ObjectId;

      // Act
      const sut = computeLooseObjectPath(id);

      // Assert
      expect(sut.split('/')[1]).toHaveLength(38);
    });

    it("Given any ObjectId, When computing path, Then contains exactly one '/'", () => {
      // Arrange
      const id = '0'.repeat(40) as ObjectId;

      // Act
      const sut = computeLooseObjectPath(id);

      // Assert
      const slashCount = sut.split('/').length - 1;
      expect(slashCount).toBe(1);
    });
  });

  describe('property-based tests', () => {
    it('Given any SHA-1 ObjectId, When computing path then removing slash, Then equals original id', () => {
      // Arrange
      fc.assert(
        fc.property(arbObjectId(40), (id) => {
          // Act
          const sut = computeLooseObjectPath(id);

          // Assert
          expect(sut.replace('/', '')).toBe(id);
        }),
      );
    });

    it('Given any SHA-256 ObjectId, When computing path then removing slash, Then equals original id', () => {
      // Arrange
      fc.assert(
        fc.property(arbObjectId(64), (id) => {
          // Act
          const sut = computeLooseObjectPath(id);

          // Assert
          expect(sut.replace('/', '')).toBe(id);
        }),
      );
    });

    it("Given any ObjectId, When computing path, Then '/' is at index 2", () => {
      // Arrange
      fc.assert(
        fc.property(arbObjectId(40), (id) => {
          // Act
          const sut = computeLooseObjectPath(id);

          // Assert
          expect(sut.indexOf('/')).toBe(2);
        }),
      );
    });
  });
});
