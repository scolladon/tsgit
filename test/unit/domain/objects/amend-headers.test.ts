import { describe, expect, it } from 'vitest';
import { amendedExtraHeaders } from '../../../../src/domain/objects/amend-headers.js';

describe('amendedExtraHeaders', () => {
  describe('Given an amended commit carrying extra headers', () => {
    describe('When reading what the amend keeps', () => {
      it('Then it keeps every header in order but the sha256 signature and the encoding', () => {
        // Arrange
        const sut = amendedExtraHeaders;
        const headers = [
          { key: 'encoding', value: 'ISO-8859-1' },
          { key: 'mergetag', value: 'object 1' },
          { key: 'gpgsig-sha256', value: 'sig' },
          { key: 'x-custom', value: 'hello' },
        ];

        // Act
        const result = sut(headers);

        // Assert
        expect(result).toEqual([
          { key: 'mergetag', value: 'object 1' },
          { key: 'x-custom', value: 'hello' },
        ]);
      });
    });
  });
});
