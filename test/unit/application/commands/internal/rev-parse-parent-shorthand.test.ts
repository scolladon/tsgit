import { describe, expect, it } from 'vitest';
import { parentShorthand } from '../../../../../src/application/commands/internal/rev-parse-parent-shorthand.js';

describe('parentShorthand', () => {
  describe.each([
    { arg: 'x^@', expected: { kind: 'parents', base: 'x' } },
    { arg: 'x^!', expected: { kind: 'exclude-parents', base: 'x' } },
    { arg: 'x^-', expected: { kind: 'exclude-parent', base: 'x', n: 1 } },
    { arg: 'x^-1', expected: { kind: 'exclude-parent', base: 'x', n: 1 } },
    { arg: 'x^-2', expected: { kind: 'exclude-parent', base: 'x', n: 2 } },
    { arg: 'x^-02', expected: { kind: 'exclude-parent', base: 'x', n: 2 } },
    { arg: 'x^-+2', expected: { kind: 'exclude-parent', base: 'x', n: 2 } },
    { arg: 'x^- \t2', expected: { kind: 'exclude-parent', base: 'x', n: 2 } },
    { arg: 'x~1^-', expected: { kind: 'exclude-parent', base: 'x~1', n: 1 } },
    { arg: '^!', expected: { kind: 'exclude-parents', base: '' } },
    { arg: 'x^@^!', expected: { kind: 'exclude-parents', base: 'x^@' } },
    { arg: 'x^-^@', expected: { kind: 'parents', base: 'x^-' } },
  ])('Given $arg', ({ arg, expected }) => {
    describe('When it is read as a parent shorthand', () => {
      it('Then it names the base and the parents git prints', () => {
        // Arrange
        const sut = parentShorthand;

        // Act
        const result = sut(arg);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe.each([
    'x',
    'x^',
    'x^2',
    'x^!x',
    'x^@x',
    'x^!^!',
    'x^@^@',
    'x^!^@',
    'x^-0',
    'x^--1',
    'x^-2x',
    'x^-+',
    'x^- 2',
  ])('Given %s', (arg) => {
    describe('When it is read as a parent shorthand', () => {
      it('Then it is none', () => {
        // Arrange
        const sut = parentShorthand;

        // Act
        const result = sut(arg);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});
