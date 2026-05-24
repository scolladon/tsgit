import { describe, expect, it } from 'vitest';
import * as operators from '../../../src/operators/index.js';

describe('operators barrel', () => {
  describe('Given the barrel module', () => {
    describe('When imported', () => {
      it('Then all operators are exposed', () => {
        // Arrange + Assert
        expect(typeof operators.filter).toBe('function');
        expect(typeof operators.find).toBe('function');
        expect(typeof operators.flatMap).toBe('function');
        expect(typeof operators.groupBy).toBe('function');
        expect(typeof operators.map).toBe('function');
        expect(typeof operators.pipe).toBe('function');
        expect(typeof operators.readableStreamToAsyncIterable).toBe('function');
        expect(typeof operators.take).toBe('function');
        expect(typeof operators.toArray).toBe('function');
      });
    });
    describe('When inspecting keys', () => {
      it('Then only the expected public surface is exposed', () => {
        // Arrange
        const expected = new Set([
          'filter',
          'find',
          'flatMap',
          'groupBy',
          'map',
          'pipe',
          'readableStreamToAsyncIterable',
          'take',
          'toArray',
        ]);

        // Act
        const actual = new Set(Object.keys(operators));

        // Assert
        expect(actual).toEqual(expected);
      });
    });
  });
});
