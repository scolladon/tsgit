import { describe, expect, it } from 'vitest';
import {
  isSkippedByLooseIterator,
  isSkippedByRefsVerify,
} from '../../../../src/domain/refs/loose-entry-name.js';

describe('isSkippedByRefsVerify', () => {
  describe('Given a ref directory entry name', () => {
    describe('When the refs-verify walk judges it', () => {
      it.each([
        ['bad.lock', true],
        ['.x.lock', false],
        ['x.locked', false],
        ['bad', false],
        ['.hidden', false],
      ])('Then %s is skipped: %s', (name, expected) => {
        // Arrange
        const sut = isSkippedByRefsVerify;

        // Act
        const result = sut(name);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('isSkippedByLooseIterator', () => {
  describe('Given a ref directory entry name', () => {
    describe('When the loose-ref iterator judges it', () => {
      it.each([
        ['.hidden', true],
        ['bad.lock', true],
        ['.x.lock', true],
        ['x.locked', false],
        ['bad', false],
      ])('Then %s is skipped: %s', (name, expected) => {
        // Arrange
        const sut = isSkippedByLooseIterator;

        // Act
        const result = sut(name);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
