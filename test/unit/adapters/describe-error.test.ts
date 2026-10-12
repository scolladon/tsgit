import { describe, expect, it } from 'vitest';
import { describeError } from '../../../src/adapters/describe-error.js';

describe('describeError', () => {
  describe('Given an Error', () => {
    describe('When it is described', () => {
      it('Then its message is returned', () => {
        // Arrange
        const sut = describeError;

        // Act
        const result = sut(new TypeError('incorrect header check'));

        // Assert
        expect(result).toBe('incorrect header check');
      });
    });
  });

  describe('Given a value that is not an Error', () => {
    describe('When it is described', () => {
      it('Then its string form is returned', () => {
        // Arrange
        const sut = describeError;

        // Act
        const result = sut(42);

        // Assert
        expect(result).toBe('42');
      });
    });
  });
});
