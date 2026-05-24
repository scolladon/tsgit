import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';
import { computeLooseObjectPath } from '../../../../src/domain/storage/loose-path.js';
import { arbObjectId } from '../objects/arbitraries.js';

describe('loose-path', () => {
  describe('computeLooseObjectPath', () => {
    describe("Given a SHA-1 ObjectId 'aabb...'", () => {
      describe('When computing path', () => {
        it("Then returns 'aa/bb...'", () => {
          // Arrange
          const sut = ('aa' + 'bb'.repeat(19)) as ObjectId;

          // Act
          const result = computeLooseObjectPath(sut);

          // Assert
          expect(result).toBe('aa/' + 'bb'.repeat(19));
        });
      });
    });

    describe('Given a SHA-256 ObjectId (64 chars)', () => {
      describe('When computing path', () => {
        it("Then returns 'xx/yy...'", () => {
          // Arrange
          const sut = ('cc' + 'dd'.repeat(31)) as ObjectId;

          // Act
          const result = computeLooseObjectPath(sut);

          // Assert
          expect(result).toBe('cc/' + 'dd'.repeat(31));
        });
      });
    });

    describe('Given any ObjectId', () => {
      describe('When computing path', () => {
        it('Then first segment is 2 chars', () => {
          // Arrange
          const sut = ('abcdef0123456789' + '0'.repeat(24)) as ObjectId;

          // Act
          const result = computeLooseObjectPath(sut);

          // Assert
          expect(result.split('/')[0]).toHaveLength(2);
        });
        it('Then second segment is remaining chars', () => {
          // Arrange
          const id = ('abcdef0123456789' + '0'.repeat(24)) as ObjectId;

          // Act
          const sut = computeLooseObjectPath(id);

          // Assert
          expect(sut.split('/')[1]).toHaveLength(38);
        });
        it("Then contains exactly one '/'", () => {
          // Arrange
          const id = '0'.repeat(40) as ObjectId;

          // Act
          const sut = computeLooseObjectPath(id);

          // Assert
          const slashCount = sut.split('/').length - 1;
          expect(slashCount).toBe(1);
        });
      });
    });
  });

  describe('property-based tests', () => {
    describe('Given any SHA-1 ObjectId', () => {
      describe('When computing path then removing slash', () => {
        it('Then equals original id', () => {
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
      });
    });

    describe('Given any SHA-256 ObjectId', () => {
      describe('When computing path then removing slash', () => {
        it('Then equals original id', () => {
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
      });
    });

    describe('Given any ObjectId', () => {
      describe('When computing path', () => {
        it("Then '/' is at index 2", () => {
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
  });
});
