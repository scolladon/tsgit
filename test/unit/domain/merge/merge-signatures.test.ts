import { describe, expect, it } from 'vitest';

import { commentLines, formatTagMessages } from '../../../../src/domain/merge/merge-signatures.js';

const SIGNATURE = '-----BEGIN PGP SIGNATURE-----\n\nAAAA\n-----END PGP SIGNATURE-----\n';

describe('commentLines', () => {
  describe('Given text with a plain, an empty and a tab-led line', () => {
    describe('When commented', () => {
      it('Then a space follows the prefix except before an empty or tab-led line', () => {
        // Arrange
        const sut = commentLines;

        // Act
        const result = sut('plain\n\n\tindented\n');

        // Assert
        expect(result).toBe('# plain\n#\n#\tindented\n');
      });
    });
  });

  describe('Given text whose last line is incomplete', () => {
    describe('When commented', () => {
      it('Then the last line is completed', () => {
        // Arrange
        const sut = commentLines;

        // Act
        const result = sut('gpg verification failed.');

        // Assert
        expect(result).toBe('# gpg verification failed.\n');
      });
    });
  });

  describe('Given empty text', () => {
    describe('When commented', () => {
      it('Then nothing is written', () => {
        // Arrange
        const sut = commentLines;

        // Act
        const result = sut('');

        // Assert
        expect(result).toBe('');
      });
    });
  });
});

describe('formatTagMessages', () => {
  describe('Given no tag', () => {
    describe('When formatted', () => {
      it('Then nothing is written', () => {
        // Arrange
        const sut = formatTagMessages;

        // Act
        const result = sut([]);

        // Assert
        expect(result).toBe('');
      });
    });
  });

  describe('Given one unsigned tag whose body lacks a final newline', () => {
    describe('When formatted', () => {
      it('Then the body follows a blank line, completed, with no origin', () => {
        // Arrange
        const sut = formatTagMessages;

        // Act
        const result = sut([{ origin: "tag 'v1'", body: 'release one' }]);

        // Assert
        expect(result).toBe('\nrelease one\n');
      });
    });
  });

  describe('Given one signed tag', () => {
    describe('When formatted', () => {
      it('Then the commented signature follows the body after a blank line', () => {
        // Arrange
        const sut = formatTagMessages;

        // Act
        const result = sut([{ origin: "tag 'v1'", body: 'release one\n', signature: SIGNATURE }]);

        // Assert
        expect(result).toBe(
          '\nrelease one\n\n# -----BEGIN PGP SIGNATURE-----\n#\n# AAAA\n# -----END PGP SIGNATURE-----\n',
        );
      });
    });
  });

  describe('Given one tag with an empty signature report', () => {
    describe('When formatted', () => {
      it('Then no signature block is written', () => {
        // Arrange
        const sut = formatTagMessages;

        // Act
        const result = sut([{ origin: "tag 'v1'", body: 'release one\n', signature: '' }]);

        // Assert
        expect(result).toBe('\nrelease one\n');
      });
    });
  });

  describe('Given a signed tag then an unsigned one', () => {
    describe('When formatted', () => {
      it('Then each block is headed by its commented origin', () => {
        // Arrange
        const sut = formatTagMessages;

        // Act
        const result = sut([
          { origin: "tag 't1'", body: 'first\n', signature: 'sig\n' },
          { origin: "tag 't2'", body: 'second\n' },
        ]);

        // Assert
        expect(result).toBe("\n\n# tag 't1'\nfirst\n\n# sig\n\n# tag 't2'\nsecond\n");
      });
    });
  });
});
