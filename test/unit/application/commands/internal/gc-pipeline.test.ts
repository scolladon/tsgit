import { describe, expect, it } from 'vitest';
import { toPackInput } from '../../../../../src/application/commands/internal/gc-pipeline.js';
import type { ClosureObject } from '../../../../../src/application/primitives/internal/closure-engine.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';

const OID = 'a'.repeat(40) as ObjectId;

describe('toPackInput', () => {
  describe('Given a closure object with no nameHash — the bitmap tier gc itself never uses', () => {
    describe('When toPackInput wraps it', () => {
      it('Then the pack input carries nameHash 0', () => {
        // Arrange
        const object: ClosureObject = { id: OID, type: 'commit' };
        const sut = toPackInput;

        // Act
        const result = sut(object);

        // Assert
        expect(result).toStrictEqual({ id: OID, nameHash: 0 });
      });
    });
  });

  describe('Given a closure object carrying a folded nameHash — the walk tier gc always uses', () => {
    describe('When toPackInput wraps it', () => {
      it('Then the pack input carries that same nameHash', () => {
        // Arrange
        const object: ClosureObject = { id: OID, type: 'blob', nameHash: 12345 };
        const sut = toPackInput;

        // Act
        const result = sut(object);

        // Assert
        expect(result).toStrictEqual({ id: OID, nameHash: 12345 });
      });
    });
  });
});
