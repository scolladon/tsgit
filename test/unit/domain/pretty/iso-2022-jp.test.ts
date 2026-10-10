import { describe, expect, it } from 'vitest';
import { buildIso2022JpEncoder } from '../../../../src/domain/pretty/iso-2022-jp.js';

describe('buildIso2022JpEncoder', () => {
  describe.each([
    ['U+0080, just past ASCII', '\u0080'],
    ['U+FFFD, the replacement character', '\uFFFD'],
  ])('Given text holding %s, which no ISO-2022-JP set encodes', (_label, text) => {
    describe('When encoding it', () => {
      it('Then the conversion fails', () => {
        // Arrange
        const sut = buildIso2022JpEncoder;

        // Act
        const result = sut()(`a${text}`);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});
