import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyDelta, parseDelta } from '../../../../src/domain/storage/delta.js';
import {
  DELTA_BLOCK_BYTES,
  encodeDelta,
  serializeDelta,
} from '../../../../src/domain/storage/delta-encode.js';
import { arbDeltaBaseTarget, arbSerializableInstructions } from './arbitraries.js';

describe('delta-encode properties', () => {
  describe('Given an arbitrary base and target', () => {
    describe('When encoding then applying', () => {
      it('Then the result equals the target', () => {
        // Arrange
        const sut = encodeDelta;

        // Act & Assert
        fc.assert(
          fc.property(arbDeltaBaseTarget(), ({ base, target }) => {
            const delta = sut(base, target)!;
            const result = applyDelta(base, delta);
            expect(result).toEqual(target);
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given an arbitrary serializable header and instruction list', () => {
    describe('When serializing then parsing', () => {
      it('Then the result equals the original header and instructions', () => {
        // Arrange
        const sut = serializeDelta;

        // Act & Assert
        fc.assert(
          fc.property(
            arbSerializableInstructions(),
            ({ sourceLength, targetLength, instructions }) => {
              const delta = sut(sourceLength, targetLength, instructions);
              const result = parseDelta(delta);
              expect(result).toEqual({ sourceLength, targetLength, instructions });
            },
          ),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given an arbitrary base and target', () => {
    describe('When encoding without a maxSize', () => {
      it('Then it never throws and always returns a Uint8Array', () => {
        // Arrange
        const sut = encodeDelta;

        // Act & Assert
        fc.assert(
          fc.property(arbDeltaBaseTarget(), ({ base, target }) => {
            const result = sut(base, target);
            expect(result).toBeInstanceOf(Uint8Array);
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given an arbitrary base and target', () => {
    describe('When encoding then parsing the emitted stream', () => {
      it('Then every INSERT length is in 1..127 and no cmd is 0 at an instruction boundary', () => {
        // Arrange
        const sut = encodeDelta;

        // Act & Assert
        fc.assert(
          fc.property(arbDeltaBaseTarget(), ({ base, target }) => {
            const delta = sut(base, target)!;
            const { instructions } = parseDelta(delta);
            for (const instruction of instructions) {
              if (instruction.type === 'insert') {
                expect(instruction.data.length).toBeGreaterThanOrEqual(1);
                expect(instruction.data.length).toBeLessThanOrEqual(127);
              }
            }
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given an arbitrary buffer longer than 4 blocks, used as both base and target', () => {
    describe('When encoding', () => {
      it('Then the result is smaller than the input', () => {
        // Arrange
        const sut = encodeDelta;

        // Act & Assert
        fc.assert(
          fc.property(
            fc.uint8Array({ minLength: DELTA_BLOCK_BYTES * 4 + 1, maxLength: 2000 }),
            (x) => {
              const result = sut(x, x)!;
              expect(result.length).toBeLessThan(x.length);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});
