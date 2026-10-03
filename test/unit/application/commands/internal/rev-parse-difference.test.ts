import { describe, expect, it } from 'vitest';
import { differenceSides } from '../../../../../src/application/commands/internal/rev-parse-difference.js';

describe('differenceSides', () => {
  describe.each([
    { arg: 'a..b', expected: { start: 'a', end: 'b' } },
    { arg: 'a...b', expected: { start: 'a', end: 'b' } },
    { arg: '..b', expected: { start: 'HEAD', end: 'b' } },
    { arg: 'a..', expected: { start: 'a', end: 'HEAD' } },
    { arg: '...', expected: { start: 'HEAD', end: 'HEAD' } },
    { arg: 'dg:a/../../x', expected: { start: 'dg:a/', end: '/../x' } },
    { arg: 'a....b', expected: { start: 'a', end: '.b' } },
  ])('Given $arg', ({ arg, expected }) => {
    describe('When it is split', () => {
      it('Then it reads the sides git reads', () => {
        // Arrange
        const sut = differenceSides;

        // Act
        const result = sut(arg);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe.each(['..', 'a.b', 'HEAD'])('Given %s', (arg) => {
    describe('When it is split', () => {
      it('Then it is no range', () => {
        // Arrange
        const sut = differenceSides;

        // Act
        const result = sut(arg);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});
