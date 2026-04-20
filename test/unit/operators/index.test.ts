import { describe, expect, it } from 'vitest';
import * as operators from '../../../src/operators/index.js';

describe('operators barrel', () => {
  it('Given the barrel module, When imported, Then all 8 operators are exposed', () => {
    // Assert
    expect(typeof operators.filter).toBe('function');
    expect(typeof operators.find).toBe('function');
    expect(typeof operators.flatMap).toBe('function');
    expect(typeof operators.groupBy).toBe('function');
    expect(typeof operators.map).toBe('function');
    expect(typeof operators.pipe).toBe('function');
    expect(typeof operators.take).toBe('function');
    expect(typeof operators.toArray).toBe('function');
  });

  it('Given the barrel module, When inspecting keys, Then only the expected public surface is exposed', () => {
    // Arrange
    const expected = new Set([
      'filter',
      'find',
      'flatMap',
      'groupBy',
      'map',
      'pipe',
      'take',
      'toArray',
    ]);

    // Act
    const actual = new Set(Object.keys(operators));

    // Assert
    expect(actual).toEqual(expected);
  });
});
