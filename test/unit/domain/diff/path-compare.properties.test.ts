import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { comparePaths } from '../../../../src/domain/diff/path-compare.js';
import {
  compareBytes,
  decodeEscapingInvalid,
  encode,
} from '../../../../src/domain/objects/encoding.js';
import type { FilePath } from '../../../../src/domain/objects/index.js';

describe('path order properties', () => {
  describe('Given any two byte strings decoded with escaping', () => {
    describe('When comparePaths is compared against compareBytes', () => {
      it('Then both agree on the sign', () => {
        fc.assert(
          fc.property(
            fc.uint8Array({ maxLength: 12 }),
            fc.uint8Array({ maxLength: 12 }),
            (a, b) => {
              // Arrange
              const left = decodeEscapingInvalid(a) as FilePath;
              const right = decodeEscapingInvalid(b) as FilePath;

              // Act
              const result = Math.sign(comparePaths(left, right));

              // Assert
              expect(result).toBe(Math.sign(compareBytes(a, b)));
            },
          ),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given any two well-formed strings', () => {
    describe('When comparePaths is compared against compareBytes of their UTF-8', () => {
      it('Then both agree on the sign', () => {
        fc.assert(
          fc.property(
            fc.string({ unit: 'binary', maxLength: 8 }),
            fc.string({ unit: 'binary', maxLength: 8 }),
            (a, b) => {
              // Arrange
              const left = a as FilePath;
              const right = b as FilePath;

              // Act
              const result = Math.sign(comparePaths(left, right));

              // Assert
              expect(result).toBe(Math.sign(compareBytes(encode(a), encode(b))));
            },
          ),
          { numRuns: 200 },
        );
      });
    });
  });
});
