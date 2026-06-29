import { describe, expect, it } from 'vitest';
import type { EnvReader } from '../../../src/ports/env-reader.js';

export function envReaderContractTests(createSut: () => EnvReader): void {
  describe('EnvReader contract', () => {
    describe('Given a name that is definitely not set in the environment', () => {
      describe('When get is called with that name', () => {
        it('Then returns undefined', () => {
          // Arrange
          const sut = createSut();

          // Act
          const result = sut.get('TSGIT_CONTRACT_TEST_DEFINITELY_NOT_SET_XYZ789');

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given an empty string name', () => {
      describe('When get is called', () => {
        it('Then does not throw', () => {
          // Arrange
          const sut = createSut();

          // Act / Assert
          expect(() => sut.get('')).not.toThrow();
        });
      });
    });
  });
}
