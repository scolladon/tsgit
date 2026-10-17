import { describe, expect, it } from 'vitest';
import {
  escapedPathOf,
  hasBytePrefix,
  indexPathKey,
  indexPathOfBytes,
  indexPathOfEscaped,
  isLossy,
  keyOfPath,
  pathBytesOf,
  splitAtSlash,
  viewOfEscaped,
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
        expect(lossyKey).toBe('\uDCFF.txt');
        expect(lossyKey).not.toBe(literalKey);
      });
    });
  });

  describe('Given a lossy entry whose directory prefix is valid UTF-8', () => {
    describe('When cutting its key at the slash', () => {
      it('Then the prefix equals the key of the directory entry', () => {
        // Arrange
        const entry = indexPathOfBytes(Uint8Array.of(0x64, 0x2f, 0xff));
        const key = indexPathKey(entry);

        // Act
        const prefix = key.slice(0, key.indexOf('/'));

        // Assert
        expect(prefix).toBe(indexPathKey({ path: 'd' as FilePath }));
      });
    });
  });

  describe('Given a lossy entry', () => {
    describe('When keying the escaped path string', () => {
      it('Then it equals the entry key', () => {
        // Arrange
        const lossy = { path: REPLACEMENT_PATH, pathBytes: LOSSY_BYTES };

        // Act
        const result = keyOfPath('\uDCFF.txt' as FilePath);

        // Assert
        expect(result).toBe(indexPathKey(lossy));
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

describe('isLossy', () => {
  describe('Given an entry carrying its raw path bytes', () => {
    describe('When asking whether it is lossy', () => {
      it('Then it is', () => {
        // Arrange
        const sut = {
          path: REPLACEMENT_PATH,
          pathBytes: Uint8Array.of(0xff, 0x2e, 0x74, 0x78, 0x74),
        };

        // Act
        const result = isLossy(sut);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given an entry whose path is its own bytes', () => {
    describe('When asking whether it is lossy', () => {
      it('Then it is not', () => {
        // Arrange
        const sut = { path: REPLACEMENT_PATH };

        // Act
        const result = isLossy(sut);

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});

describe('escapedPathOf', () => {
  describe('Given a lossy entry', () => {
    describe('When escaping its path', () => {
      it('Then each rejected byte is a lone low surrogate', () => {
        // Arrange
        const sut = { path: REPLACEMENT_PATH, pathBytes: LOSSY_BYTES };

        // Act
        const result = escapedPathOf(sut);

        // Assert
        expect(result).toBe('\uDCFF.txt');
      });
    });
  });

  describe('Given an entry whose path is its own bytes', () => {
    describe('When escaping its path', () => {
      it('Then it is the same path instance', () => {
        // Arrange
        const sut = { path: REPLACEMENT_PATH };

        // Act
        const result = escapedPathOf(sut);

        // Assert
        expect(result).toBe(sut.path);
      });
    });
  });
});

describe('indexPathOfEscaped', () => {
  describe('Given an escaped path holding a lone escape', () => {
    describe('When building the index path', () => {
      it('Then it carries the view and the raw bytes', () => {
        // Arrange
        const sut = '\uDCFF.txt' as FilePath;

        // Act
        const result = indexPathOfEscaped(sut);

        // Assert
        expect(result).toEqual({ path: '�.txt', pathBytes: LOSSY_BYTES });
      });
    });
  });

  describe('Given a well-formed path', () => {
    describe('When building the index path', () => {
      it('Then it has no pathBytes key', () => {
        // Arrange
        const sut = 'a/b' as FilePath;

        // Act
        const result = indexPathOfEscaped(sut);

        // Assert
        expect(result).toStrictEqual({ path: 'a/b' });
      });
    });
  });

  describe('Given a non-canonical escape of a valid sequence', () => {
    describe('When building the index path', () => {
      it('Then the bytes are valid UTF-8 and no pathBytes key is kept', () => {
        // Arrange
        const sut = '\uDCC3\uDCA9' as FilePath;

        // Act
        const result = indexPathOfEscaped(sut);

        // Assert
        expect(result).toStrictEqual({ path: 'é' });
      });
    });
  });
});

describe('viewOfEscaped', () => {
  describe('Given an escaped maximal subpart', () => {
    describe('When viewing it', () => {
      it('Then it is one replacement character', () => {
        // Arrange
        const sut = '\uDCE2\uDC80A' as FilePath;

        // Act
        const result = viewOfEscaped(sut);

        // Assert
        expect(result).toBe('�A');
      });
    });
  });

  describe('Given a well-formed path', () => {
    describe('When viewing it', () => {
      it('Then the input comes back', () => {
        // Arrange
        const sut = 'a/b' as FilePath;

        // Act
        const result = viewOfEscaped(sut);

        // Assert
        expect(result).toBe(sut);
      });
    });
  });
});

describe('hasBytePrefix', () => {
  describe.each([
    ['the prefix followed by a slash', [0xff, 0x2f, 0x78], [0xff], true],
    [
      'a different prefix whose decoded view matches',
      [0xff, 0x2f, 0x78],
      [0xef, 0xbf, 0xbd],
      false,
    ],
    ['a prefix differing in its first byte only', [0xff, 0x62, 0x2f, 0x78], [0xfe, 0x62], false],
    ['the prefix with nothing after it', [0xff], [0xff], false],
    ['the prefix followed by a non-slash byte', [0xff, 0x78], [0xff], false],
  ])('Given bytes holding %s', (_title, bytes, prefix, expected) => {
    describe('When testing for the directory prefix', () => {
      it(`Then it answers ${expected}`, () => {
        // Arrange
        const sut = hasBytePrefix;

        // Act
        const result = sut(Uint8Array.from(bytes), Uint8Array.from(prefix));

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
