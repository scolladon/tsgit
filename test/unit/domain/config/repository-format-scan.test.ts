import { describe, expect, it } from 'vitest';
import { tokenizeConfig } from '../../../../src/domain/config/config-ini.js';
import {
  honoursExtensions,
  refStorageReadBeforeMalformedVersion,
} from '../../../../src/domain/config/repository-format-scan.js';

describe('refStorageReadBeforeMalformedVersion', () => {
  describe('Given a refStorage declared after a malformed version outside the core section', () => {
    describe('When the order is asked', () => {
      it('Then no core version is malformed, so the refStorage is read first', () => {
        // Arrange
        const tokens = tokenizeConfig(
          '[other]\n\trepositoryformatversion = abc\n[extensions]\n\trefStorage = reftable\n',
        );
        const sut = refStorageReadBeforeMalformedVersion;

        // Act
        const verdict = sut(tokens);

        // Assert
        expect(verdict).toBe(true);
      });
    });
  });

  describe('Given a refStorage declared after a malformed core version', () => {
    describe('When the order is asked', () => {
      it('Then the malformed version is read first', () => {
        // Arrange
        const tokens = tokenizeConfig(
          '[core]\n\trepositoryformatversion = abc\n[extensions]\n\trefStorage = reftable\n',
        );
        const sut = refStorageReadBeforeMalformedVersion;

        // Act
        const verdict = sut(tokens);

        // Assert
        expect(verdict).toBe(false);
      });
    });
  });
});

describe('honoursExtensions', () => {
  describe.each([
    { version: undefined, expected: false },
    { version: 0, expected: false },
    { version: 1, expected: true },
    { version: 2, expected: true },
  ])('Given format version $version', ({ version, expected }) => {
    describe('When asked whether extensions are honoured', () => {
      it(`Then the answer is ${expected}`, () => {
        // Arrange
        const sut = honoursExtensions;

        // Act
        const honoured = sut(version);

        // Assert
        expect(honoured).toBe(expected);
      });
    });
  });
});
