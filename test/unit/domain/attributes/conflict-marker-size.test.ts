import { describe, expect, it } from 'vitest';

import {
  type AttributeValue,
  DEFAULT_CONFLICT_MARKER_SIZE,
  resolveMarkerSize,
} from '../../../../src/domain/attributes/index.js';

describe('resolveMarkerSize', () => {
  describe('Given a positive integer value', () => {
    describe('When resolved', () => {
      it.each([
        ['7', 7],
        ['1', 1],
        ['70', 70],
        ['+5', 5],
        ['00008', 8],
        ['2147483647', 2147483647],
      ])('Then `%s` yields %i', (raw, expected) => {
        // Arrange
        const sut: AttributeValue = { set: raw };

        // Act
        const result = resolveMarkerSize(sut);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given a non-positive or unparseable value', () => {
    describe('When resolved', () => {
      it.each([
        ['0'],
        ['-3'],
        ['12abc'],
        ['0x10'],
        ['15.9'],
        [''],
        ['2147483648'],
        ['99999999999999999999'],
        ['  5'],
      ])('Then `%s` falls back to the default 7', (raw) => {
        // Arrange
        const sut: AttributeValue = { set: raw };

        // Act
        const result = resolveMarkerSize(sut);

        // Assert
        expect(result).toBe(DEFAULT_CONFLICT_MARKER_SIZE);
      });
    });
  });

  describe('Given a non-valued attribute state', () => {
    describe('When resolved', () => {
      it.each<[AttributeValue]>([[true], [false], ['unspecified']])(
        'Then it falls back to the default 7',
        (sut) => {
          // Act
          const result = resolveMarkerSize(sut);

          // Assert
          expect(result).toBe(DEFAULT_CONFLICT_MARKER_SIZE);
        },
      );
    });
  });

  describe('Given the exported default', () => {
    describe('When read', () => {
      it('Then it is git`s 7', () => {
        // Arrange + Act + Assert
        expect(DEFAULT_CONFLICT_MARKER_SIZE).toBe(7);
      });
    });
  });
});
