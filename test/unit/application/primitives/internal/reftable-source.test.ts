import { describe, expect, it } from 'vitest';
import {
  isDegradableReftableFault,
  tierOf,
} from '../../../../../src/application/primitives/internal/reftable-source.js';
import { fileNotFound, permissionDenied } from '../../../../../src/domain/error.js';
import { invalidReftable, type ReftableCheck } from '../../../../../src/domain/refs/error.js';

const EVERY_REFTABLE_CHECK: readonly ReftableCheck[] = [
  'magic',
  'version',
  'footer-crc',
  'truncated',
  'block-type',
  'restart-count',
  'record-overrun',
  'varint-overflow',
  'tables-list',
];

describe('reftable-source', () => {
  describe('Given each member of the reftable check union', () => {
    describe('When its tier is resolved', () => {
      it.each(EVERY_REFTABLE_CHECK)('Then %s classifies as refuse', (check) => {
        // Arrange
        const sut = tierOf;

        // Act
        const result = sut(check);

        // Assert
        expect(result).toBe('refuse');
      });
    });
  });

  describe('Given a FILE_NOT_FOUND error on tables.list itself', () => {
    describe('When isDegradableReftableFault classifies it', () => {
      it('Then a missing tables.list degrades to an empty stack', () => {
        // Arrange
        const sut = isDegradableReftableFault;
        const err = fileNotFound('/repo/.git/reftable/tables.list');

        // Act
        const result = sut(err);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a FILE_NOT_FOUND error on the reftable directory itself', () => {
    describe('When isDegradableReftableFault classifies it', () => {
      it('Then a missing reftable directory degrades to an empty stack', () => {
        // Arrange
        const sut = isDegradableReftableFault;
        const err = fileNotFound('/repo/.git/reftable');

        // Act
        const result = sut(err);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given an INVALID_REFTABLE structural fault', () => {
    describe('When isDegradableReftableFault classifies it', () => {
      it('Then it is not degradable', () => {
        // Arrange
        const sut = isDegradableReftableFault;
        const err = invalidReftable('magic', 'invalid magic');

        // Act
        const result = sut(err);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given an unrelated io fault', () => {
    describe('When isDegradableReftableFault classifies it', () => {
      it('Then it is not degradable', () => {
        // Arrange
        const sut = isDegradableReftableFault;
        const err = permissionDenied('/repo/.git/reftable/tables.list');

        // Act
        const result = sut(err);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a value with no data.code shape at all', () => {
    describe('When isDegradableReftableFault classifies it', () => {
      it('Then it is not degradable', () => {
        // Arrange
        const sut = isDegradableReftableFault;

        // Act
        const result = sut(new Error('boom'));

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});
