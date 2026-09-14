import { describe, expect, it } from 'vitest';
import { errorDataCode } from '../../../src/domain/error-data-code.js';

describe('errorDataCode', () => {
  describe('Given a value to classify', () => {
    describe('When reading its structural error code', () => {
      it.each([
        {
          label: 'an object whose data.code is a string returns that string',
          value: { data: { code: 'OBJECT_NOT_FOUND' } },
          expected: 'OBJECT_NOT_FOUND',
        },
        { label: 'null returns undefined', value: null, expected: undefined },
        { label: 'a string returns undefined', value: 'boom', expected: undefined },
        { label: 'a number returns undefined', value: 42, expected: undefined },
        { label: 'undefined returns undefined', value: undefined, expected: undefined },
        {
          label: 'an object without data returns undefined',
          value: {},
          expected: undefined,
        },
        {
          label: 'data without code returns undefined',
          value: { data: {} },
          expected: undefined,
        },
        {
          label: 'data.code a number returns undefined',
          value: { data: { code: 404 } },
          expected: undefined,
        },
      ])('Then $label', ({ value, expected }) => {
        // Act
        const result = errorDataCode(value);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
