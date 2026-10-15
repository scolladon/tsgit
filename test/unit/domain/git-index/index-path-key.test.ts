import { describe, expect, it } from 'vitest';
import {
  indexPathKey,
  indexPathOfBytes,
  keyOfPath,
  latin1,
  pathBytesOf,
  splitAtSlash,
} from '../../../../src/domain/git-index/index-path-key.js';
import { encode } from '../../../../src/domain/objects/encoding.js';
import { FilePath } from '../../../../src/domain/objects/index.js';

const LOSSY_BYTES = Uint8Array.of(0xff, 0x2e, 0x74, 0x78, 0x74);
const REPLACEMENT_PATH = FilePath.from('�.txt');

describe('indexPathKey', () => {
  describe('Given a lossy entry and a literal U+FFFD entry sharing one decoded view', () => {
    describe('When keying each', () => {
      it('Then the keys differ and follow the documented scheme', () => {
        // Arrange
        const lossy = { path: REPLACEMENT_PATH, pathBytes: LOSSY_BYTES };
        const literal = { path: REPLACEMENT_PATH };

        // Act
        const lossyKey = indexPathKey(lossy);
        const literalKey = indexPathKey(literal);

        // Assert
        expect(literalKey).toBe('�.txt');
        expect(lossyKey).toBe(String.fromCharCode(0, 0xff, 0x2e, 0x74, 0x78, 0x74));
        expect(lossyKey).not.toBe(literalKey);
      });
    });
  });
});

describe('indexPathOfBytes', () => {
  describe('Given non-UTF-8 bytes', () => {
    describe('When building the path', () => {
      it('Then it keeps a copy of the bytes next to the decoded view', () => {
        // Arrange
        const bytes = LOSSY_BYTES;

        // Act
        const result = indexPathOfBytes(bytes);

        // Assert
        expect(result.path).toBe('�.txt');
        expect(result.pathBytes).toEqual(bytes);
        expect(result.pathBytes).not.toBe(bytes);
      });
    });
  });

  describe('Given valid UTF-8 bytes', () => {
    describe('When building the path', () => {
      it('Then no pathBytes key is present', () => {
        // Arrange
        const bytes = Uint8Array.of(0xc3, 0xa9);

        // Act
        const result = indexPathOfBytes(bytes);

        // Assert
        expect(result).toEqual({ path: 'é' });
        expect('pathBytes' in result).toBe(false);
      });
    });
  });

  describe('Given bytes opening with a BOM', () => {
    describe('When building the path', () => {
      it('Then the BOM stays in the view and no pathBytes key is present', () => {
        // Arrange
        const bytes = Uint8Array.of(0xef, 0xbb, 0xbf, 0x61);

        // Act
        const result = indexPathOfBytes(bytes);

        // Assert
        expect(result).toEqual({ path: '﻿a' });
        expect('pathBytes' in result).toBe(false);
      });
    });
  });
});

describe('pathBytesOf', () => {
  describe('Given a lossy entry', () => {
    describe('When reading its bytes', () => {
      it('Then it returns the stored instance', () => {
        // Arrange
        const entry = { path: REPLACEMENT_PATH, pathBytes: LOSSY_BYTES };

        // Act
        const result = pathBytesOf(entry);

        // Assert
        expect(result).toBe(LOSSY_BYTES);
      });
    });
  });

  describe('Given a UTF-8 entry', () => {
    describe('When reading its bytes', () => {
      it('Then it returns the encoded path', () => {
        // Arrange
        const entry = { path: FilePath.from('é/a') };

        // Act
        const result = pathBytesOf(entry);

        // Assert
        expect(result).toEqual(encode('é/a'));
      });
    });
  });
});

describe('keyOfPath', () => {
  describe('Given a string path', () => {
    describe('When keying it', () => {
      it('Then the path is its own key', () => {
        // Arrange
        const path = FilePath.from('a/b');

        // Act
        const result = keyOfPath(path);

        // Assert
        expect(result).toBe('a/b');
      });
    });
  });
});

describe('splitAtSlash', () => {
  describe('Given bytes holding a slash', () => {
    describe('When splitting', () => {
      it('Then each side is its own part', () => {
        // Arrange
        const bytes = Uint8Array.of(0xff, 0x2f, 0x78);

        // Act
        const result = splitAtSlash(bytes);

        // Assert
        expect(result).toEqual([Uint8Array.of(0xff), Uint8Array.of(0x78)]);
      });
    });
  });

  describe('Given bytes without a slash', () => {
    describe('When splitting', () => {
      it('Then one part equals the input', () => {
        // Arrange
        const bytes = Uint8Array.of(0x61, 0xff);

        // Act
        const result = splitAtSlash(bytes);

        // Assert
        expect(result).toEqual([bytes]);
      });
    });
  });
});

describe('latin1', () => {
  describe('Given every byte value', () => {
    describe('When converting', () => {
      it('Then each byte maps to the char with the same code', () => {
        // Arrange
        const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);

        // Act
        const result = latin1(bytes);

        // Assert
        expect(result.length).toBe(256);
        expect([...result].map((c) => c.charCodeAt(0))).toEqual([...bytes]);
      });
    });
  });
});
