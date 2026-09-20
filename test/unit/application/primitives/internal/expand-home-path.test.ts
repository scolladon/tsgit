import { describe, expect, it } from 'vitest';
import { expandHomePrefix } from '../../../../../src/application/primitives/internal/expand-home-path.js';

describe('expandHomePrefix', () => {
  describe('Given a path that does not open with the home prefix, and a home to expand against', () => {
    describe('When expandHomePrefix is called', () => {
      it('Then the path is returned exactly as written, untouched by the home', () => {
        // Arrange
        const sut = expandHomePrefix;

        // Act
        const result = sut('/repo/.git/skip-list', '/home/me');

        // Assert
        expect(result).toBe('/repo/.git/skip-list');
      });
    });
  });

  describe('Given a path opening with the home prefix, and a home to expand against', () => {
    describe('When expandHomePrefix is called', () => {
      it('Then the prefix is replaced by the home directory', () => {
        // Arrange
        const sut = expandHomePrefix;

        // Act
        const result = sut('~/names.txt', '/home/me');

        // Assert
        expect(result).toBe('/home/me/names.txt');
      });
    });
  });

  describe('Given a path opening with the home prefix and no home known', () => {
    describe('When expandHomePrefix is called', () => {
      it('Then it answers undefined, leaving the caller to decide what that means', () => {
        // Arrange
        const sut = expandHomePrefix;

        // Act
        const result = sut('~/names.txt', undefined);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a ~user path, which git resolves through the passwd database instead', () => {
    describe('When expandHomePrefix is called', () => {
      it('Then it is returned verbatim, never mistaken for the home prefix', () => {
        // Arrange
        const sut = expandHomePrefix;

        // Act
        const result = sut('~other/names.txt', '/home/me');

        // Assert
        expect(result).toBe('~other/names.txt');
      });
    });
  });
});
