import { describe, expect, it } from 'vitest';

import { asIdSet } from '../../../../../src/application/primitives/internal/as-id-set.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';

const ID_A = 'a'.repeat(40) as ObjectId;
const ID_B = 'b'.repeat(40) as ObjectId;

describe('asIdSet', () => {
  describe('Given an array of ids', () => {
    describe('When asIdSet is called', () => {
      it('Then returns a new set with the same members', () => {
        // Arrange
        const sut = asIdSet;
        const until = [ID_A, ID_B];

        // Act
        const result = sut(until);

        // Assert
        expect(result).not.toBe(until);
        expect([...result]).toEqual([ID_A, ID_B]);
      });
    });
  });

  describe('Given a Set of ids', () => {
    describe('When asIdSet is called', () => {
      it('Then returns the SAME set instance by reference', () => {
        // Arrange
        const sut = asIdSet;
        const until = new Set<ObjectId>([ID_A]);

        // Act
        const result = sut(until);

        // Assert
        expect(result).toBe(until);
      });
    });
  });

  describe('Given undefined', () => {
    describe('When asIdSet is called', () => {
      it('Then returns an empty set', () => {
        // Arrange
        const sut = asIdSet;

        // Act
        const result = sut(undefined);

        // Assert
        expect([...result]).toEqual([]);
      });
    });
  });
});
