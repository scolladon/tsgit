import { describe, expect, it } from 'vitest';
import {
  differenceSides,
  rangeSides,
} from '../../../../../src/application/commands/internal/rev-parse-difference.js';

describe('differenceSides', () => {
  describe.each([
    { arg: 'a..b', expected: { start: 'a', end: 'b', symmetric: false } },
    { arg: 'a...b', expected: { start: 'a', end: 'b', symmetric: true } },
    { arg: '..b', expected: { start: 'HEAD', end: 'b', symmetric: false } },
    { arg: 'a..', expected: { start: 'a', end: 'HEAD', symmetric: false } },
    { arg: '...', expected: { start: 'HEAD', end: 'HEAD', symmetric: true } },
    { arg: 'dg:a/../../x', expected: { start: 'dg:a/', end: '/../x', symmetric: false } },
    { arg: 'a....b', expected: { start: 'a', end: '.b', symmetric: true } },
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

describe('rangeSides', () => {
  describe.each([
    { arg: '..', expected: { start: 'HEAD', end: 'HEAD', symmetric: false } },
    { arg: 'a..b', expected: { start: 'a', end: 'b', symmetric: false } },
    { arg: 'HEAD', expected: undefined },
  ])('Given $arg, where it cannot be a filename', ({ arg, expected }) => {
    describe('When it is split', () => {
      it('Then it reads the sides git reads', () => {
        // Arrange
        const sut = rangeSides;

        // Act
        const result = sut(arg);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });
});
