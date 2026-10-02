import { describe, expect, it } from 'vitest';
import {
  signatureHeaderFor,
  splitSignedCommit,
} from '../../../../src/domain/pretty/signed-commit.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const HEAD = 'tree t\nauthor a\ncommitter c\n';
const SIGNED = `${HEAD}gpgsig -----BEGIN-----\n line\n -----END-----\nmergetag x\n\nmsg\ngpgsig body\n`;

describe('splitSignedCommit', () => {
  describe('Given a commit signed under the repository hash header', () => {
    describe('When splitting it', () => {
      it('Then the signature lines leave the payload and form the signature', () => {
        // Arrange
        const sut = splitSignedCommit;

        // Act
        const result = sut(encode(SIGNED), 'gpgsig');

        // Assert
        expect(result && decode(result.payload)).toBe(`${HEAD}mergetag x\n\nmsg\ngpgsig body\n`);
        expect(result && decode(result.signature)).toBe('-----BEGIN-----\nline\n-----END-----\n');
      });
    });
  });

  describe('Given a commit carrying only the other hash header', () => {
    describe('When splitting it', () => {
      it('Then it is unsigned', () => {
        // Arrange
        const sut = splitSignedCommit;

        // Act
        const result = sut(encode(`${HEAD}gpgsig-sha256 sig\n cont\n\nmsg\n`), 'gpgsig');

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a commit signed under both hash headers', () => {
    describe('When splitting it for the first', () => {
      it('Then the other signature is dropped from the payload too', () => {
        // Arrange
        const sut = splitSignedCommit;
        const raw = `${HEAD}gpgsig-sha256 other\n more\ngpgsig mine\n end\nx y\n\nmsg\n`;

        // Act
        const result = sut(encode(raw), 'gpgsig');

        // Assert
        expect(result && decode(result.payload)).toBe(`${HEAD}x y\n\nmsg\n`);
        expect(result && decode(result.signature)).toBe('mine\nend\n');
      });
    });
  });

  describe('Given a commit whose last header line has no line feed', () => {
    describe('When splitting it', () => {
      it('Then the signature keeps the unterminated line', () => {
        // Arrange
        const sut = splitSignedCommit;

        // Act
        const result = sut(encode(`${HEAD}gpgsig only`), 'gpgsig');

        // Assert
        expect(result && decode(result.payload)).toBe(HEAD);
        expect(result && decode(result.signature)).toBe('only');
      });
    });
  });
});

describe('Given each repository hash', () => {
  describe('When choosing the signature header', () => {
    it.each([
      ['sha1', 'gpgsig'],
      ['sha256', 'gpgsig-sha256'],
    ] as const)('Then %s commits are signed under %s', (algorithm, expected) => {
      // Arrange
      const sut = signatureHeaderFor;

      // Act
      const result = sut(algorithm);

      // Assert
      expect(result).toBe(expected);
    });
  });
});
