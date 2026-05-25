import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseHeader, serializeHeader } from '../../../../src/domain/objects/header.js';
import { arbObjectType } from './arbitraries.js';

describe('header properties', () => {
  describe('Given an arbitrary object type and a non-negative size', () => {
    describe('When parseHeader(serializeHeader(type, size))', () => {
      it('Then type, size and contentOffset are recovered', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbObjectType(), fc.nat({ max: 2 ** 31 - 1 }), (type, size) => {
            const serialized = serializeHeader(type, size);
            const sut = parseHeader(serialized);
            expect(sut.type).toBe(type);
            expect(sut.size).toBe(size);
            expect(sut.contentOffset).toBe(serialized.length);
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given arbitrary bytes that contain no NUL terminator', () => {
    describe('When parseHeader is called', () => {
      it('Then it throws INVALID_OBJECT_HEADER with a "missing null terminator" reason', () => {
        // Arrange + Act + Assert
        const arbNoNulBytes = fc
          .uint8Array({ minLength: 1, maxLength: 256 })
          .filter((bytes) => !bytes.includes(0));
        fc.assert(
          fc.property(arbNoNulBytes, (sut) => {
            expect(() => parseHeader(sut)).toThrow(
              expect.objectContaining({
                data: expect.objectContaining({
                  code: 'INVALID_OBJECT_HEADER',
                  reason: 'missing null terminator',
                }),
              }),
            );
          }),
          { numRuns: 50 },
        );
      });
    });
  });
});
