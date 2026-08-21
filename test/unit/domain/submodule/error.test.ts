import { describe, expect, it } from 'vitest';

import { submoduleObjectFormatMismatch } from '../../../../src/domain/submodule/error.js';

describe('submoduleObjectFormatMismatch', () => {
  describe('Given a superproject and a submodule source on different algorithms', () => {
    describe('When the helper is called', () => {
      it('Then the payload names each side, so a caller can tell which end to change', () => {
        // Arrange
        const sut = submoduleObjectFormatMismatch;

        // Act
        const result = sut('sha1', 'sha256');

        // Assert
        expect(result.data).toEqual({
          code: 'SUBMODULE_OBJECT_FORMAT_MISMATCH',
          local: 'sha1',
          remote: 'sha256',
        });
      });
    });
  });

  describe('Given the mirrored direction', () => {
    describe('When the helper is called', () => {
      it('Then local and remote are not transposed', () => {
        // Arrange — the transposition is invisible to a single-direction test:
        // both fields are the same two-member enum, so only asserting the
        // mirror proves the arguments reach the fields they name.
        const sut = submoduleObjectFormatMismatch;

        // Act
        const result = sut('sha256', 'sha1');

        // Assert
        expect(result.data).toEqual({
          code: 'SUBMODULE_OBJECT_FORMAT_MISMATCH',
          local: 'sha256',
          remote: 'sha1',
        });
      });
    });
  });
});
