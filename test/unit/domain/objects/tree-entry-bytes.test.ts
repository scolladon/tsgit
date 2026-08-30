import { describe, expect, it } from 'vitest';

import { encode } from '../../../../src/domain/objects/encoding.js';
import {
  entryNameKey,
  hasNonOctalByte,
  matchesDotgitAlias,
} from '../../../../src/domain/objects/tree-entry-bytes.js';

function concatBytes(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const BOM = Uint8Array.of(0xef, 0xbb, 0xbf); // ZERO WIDTH NO-BREAK SPACE, used leading and trailing
const U200C = Uint8Array.of(0xe2, 0x80, 0x8c); // ZERO WIDTH NON-JOINER
const U200D = Uint8Array.of(0xe2, 0x80, 0x8d); // ZERO WIDTH JOINER
const U200E = Uint8Array.of(0xe2, 0x80, 0x8e); // LEFT-TO-RIGHT MARK
const U202A = Uint8Array.of(0xe2, 0x80, 0xaa); // LEFT-TO-RIGHT EMBEDDING
const U206A = Uint8Array.of(0xe2, 0x81, 0xaa); // INHIBIT SYMMETRIC SWAPPING

describe('hasNonOctalByte', () => {
  describe("Given a single-byte span at the low octal boundary (0x30, '0')", () => {
    describe('When scanning', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = hasNonOctalByte;
        const buf = Uint8Array.of(0x30);

        // Act
        const result = sut(buf, 0, 1);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe("Given a single-byte span at the high octal boundary (0x37, '7')", () => {
    describe('When scanning', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = hasNonOctalByte;
        const buf = Uint8Array.of(0x37);

        // Act
        const result = sut(buf, 0, 1);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe("Given a single-byte span just above the high octal boundary (0x38, '8')", () => {
    describe('When scanning', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = hasNonOctalByte;
        const buf = Uint8Array.of(0x38);

        // Act
        const result = sut(buf, 0, 1);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a single-byte span holding a slash', () => {
    describe('When scanning', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = hasNonOctalByte;
        const buf = Uint8Array.of(0x2f);

        // Act
        const result = sut(buf, 0, 1);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a single-byte span holding NUL', () => {
    describe('When scanning', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = hasNonOctalByte;
        const buf = Uint8Array.of(0x00);

        // Act
        const result = sut(buf, 0, 1);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given an empty span (start === end)', () => {
    describe('When scanning', () => {
      it('Then returns false', () => {
        // Arrange — a non-octal byte sits just outside the (empty) span
        const sut = hasNonOctalByte;
        const buf = Uint8Array.of(0x38);

        // Act
        const result = sut(buf, 0, 0);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a span of otherwise-octal bytes whose last byte is non-octal', () => {
    describe('When scanning', () => {
      it('Then returns true', () => {
        // Arrange — a loop that stops one short of `end` would miss this byte
        const sut = hasNonOctalByte;
        const buf = encode('10064a');

        // Act
        const result = sut(buf, 0, buf.length);

        // Assert
        expect(result).toBe(true);
      });
    });
  });
});

describe('entryNameKey', () => {
  describe(
    'Given the six bytes that a windows-1252-aliased latin1 decoder would remap ' +
      '(0xFF, 0xFE, 0x81, 0x8D, 0x90, 0x9D)',
    () => {
      describe('When keying each one-byte span', () => {
        it('Then every byte produces a distinct key', () => {
          // Arrange
          const sut = entryNameKey;
          const bytes = [0xff, 0xfe, 0x81, 0x8d, 0x90, 0x9d];

          // Act
          const keys = bytes.map((byte) => sut(Uint8Array.of(byte), 0, 1));

          // Assert
          expect(new Set(keys).size).toBe(bytes.length);
        });
      });
    },
  );

  describe('Given a 4097-byte name spanning multiple chunk boundaries', () => {
    describe('When keying the whole span', () => {
      it('Then returns a 4097-code-unit key with the right byte at each chunk edge', () => {
        // Arrange — a loop that drops, duplicates, or shifts a byte at a chunk
        // boundary (chunk size 1024) would corrupt content, not just length.
        const sut = entryNameKey;
        const buf = new Uint8Array(4097);
        for (let i = 0; i < buf.length; i++) buf[i] = i % 256;

        // Act
        const result = sut(buf, 0, buf.length);

        // Assert
        expect(result).toHaveLength(4097);
        expect(result.charCodeAt(0)).toBe(0);
        expect(result.charCodeAt(1023)).toBe(1023 % 256);
        expect(result.charCodeAt(1024)).toBe(1024 % 256);
        expect(result.charCodeAt(4096)).toBe(4096 % 256);
      });
    });
  });

  describe('Given an empty span (start === end)', () => {
    describe('When keying', () => {
      it('Then returns the empty string', () => {
        // Arrange
        const sut = entryNameKey;
        const buf = Uint8Array.of(0x61);

        // Act
        const result = sut(buf, 0, 0);

        // Assert
        expect(result).toBe('');
      });
    });
  });
});

describe('matchesDotgitAlias', () => {
  describe('Given the git 2.55.0 `fsck --strict` hasDotgit matrix', () => {
    const rows: ReadonlyArray<{
      readonly label: string;
      readonly nameBytes: Uint8Array;
      readonly expected: boolean;
    }> = [
      { label: '.git', nameBytes: encode('.git'), expected: true },
      { label: '.GIT (case)', nameBytes: encode('.GIT'), expected: true },
      { label: '.Git (case)', nameBytes: encode('.Git'), expected: true },
      { label: 'git~1 (NTFS short name)', nameBytes: encode('git~1'), expected: true },
      { label: 'GIT~1', nameBytes: encode('GIT~1'), expected: true },
      { label: '.git. (NTFS trailing dot)', nameBytes: encode('.git.'), expected: true },
      { label: '.git  (NTFS trailing space)', nameBytes: encode('.git '), expected: true },
      {
        label: '<BOM>.git (HFS ignorable, leading)',
        nameBytes: concatBytes(BOM, encode('.git')),
        expected: true,
      },
      {
        label: '.g<U+200C>it (HFS, mid)',
        nameBytes: concatBytes(encode('.g'), U200C, encode('it')),
        expected: true,
      },
      {
        label: '.gi<U+200D>t (HFS, mid)',
        nameBytes: concatBytes(encode('.gi'), U200D, encode('t')),
        expected: true,
      },
      {
        label: '.git<U+200E> (HFS, trailing)',
        nameBytes: concatBytes(encode('.git'), U200E),
        expected: true,
      },
      { label: '.git<U+202A>', nameBytes: concatBytes(encode('.git'), U202A), expected: true },
      { label: '.git<U+206A>', nameBytes: concatBytes(encode('.git'), U206A), expected: true },
      { label: '.git<U+FEFF>', nameBytes: concatBytes(encode('.git'), BOM), expected: true },
      { label: '..git (negative control)', nameBytes: encode('..git'), expected: false },
      { label: 'gi~1 (negative control)', nameBytes: encode('gi~1'), expected: false },
    ];

    describe('When matching each name against the "git" alias', () => {
      it.each(rows)('Then $label resolves to $expected', ({ nameBytes, expected }) => {
        // Arrange
        const sut = matchesDotgitAlias;

        // Act
        const result = sut(nameBytes, 0, nameBytes.length, 'git');

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe(
    'Given git 2.55.0-measured aliases for the .gitmodules/.gitattributes/.gitignore/' +
      '.mailmap family',
    () => {
      const rows: ReadonlyArray<{
        readonly label: string;
        readonly alias: 'gitmodules' | 'gitattributes' | 'gitignore' | 'mailmap';
        readonly nameBytes: Uint8Array;
      }> = [
        { label: '.gitmodules', alias: 'gitmodules', nameBytes: encode('.gitmodules') },
        { label: '.GITMODULES (case)', alias: 'gitmodules', nameBytes: encode('.GITMODULES') },
        {
          label: '<BOM>.gitmodules (HFS, leading)',
          alias: 'gitmodules',
          nameBytes: concatBytes(BOM, encode('.gitmodules')),
        },
        {
          label: 'gitmod~1 (NTFS short name)',
          alias: 'gitmodules',
          nameBytes: encode('gitmod~1'),
        },
        {
          label: '.gitmodules<U+200C> (HFS, trailing)',
          alias: 'gitmodules',
          nameBytes: concatBytes(encode('.gitmodules'), U200C),
        },
        { label: '.mailmap', alias: 'mailmap', nameBytes: encode('.mailmap') },
        { label: '.MAILMAP (case)', alias: 'mailmap', nameBytes: encode('.MAILMAP') },
        { label: '.gitignore', alias: 'gitignore', nameBytes: encode('.gitignore') },
        { label: '.gitattributes', alias: 'gitattributes', nameBytes: encode('.gitattributes') },
        {
          label: '.GITATTRIBUTES (case)',
          alias: 'gitattributes',
          nameBytes: encode('.GITATTRIBUTES'),
        },
      ];

      describe('When matching each name against its own family alias', () => {
        it.each(rows)('Then $label matches the $alias alias', ({ alias, nameBytes }) => {
          // Arrange
          const sut = matchesDotgitAlias;

          // Act
          const result = sut(nameBytes, 0, nameBytes.length, alias);

          // Assert
          expect(result).toBe(true);
        });
      });
    },
  );

  describe('Given an NTFS short name whose digit is outside the accepted 1-4 range', () => {
    describe('When matching against "gitmodules"', () => {
      it('Then gitmod~5 does not match (git only ever assigns short names ~1 through ~4)', () => {
        // Arrange
        const sut = matchesDotgitAlias;
        const buf = encode('gitmod~5');

        // Act
        const result = sut(buf, 0, buf.length, 'gitmodules');

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given the NTFS short name for plain "git" with a digit other than 1', () => {
    describe('When matching against "git"', () => {
      it('Then git~2 does not match (git only ever assigns .git the short name git~1)', () => {
        // Arrange — is_ntfs_dotgit hard-codes '~1'; unlike the generic
        // family fold, it never accepts ~2 through ~4.
        const sut = matchesDotgitAlias;
        const buf = encode('git~2');

        // Act
        const result = sut(buf, 0, buf.length, 'git');

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given trailing content after an NTFS short name that is neither a dot nor a space', () => {
    describe('When matching against "git"', () => {
      it('Then git~1extra does not match', () => {
        // Arrange
        const sut = matchesDotgitAlias;
        const buf = encode('git~1extra');

        // Act
        const result = sut(buf, 0, buf.length, 'git');

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a name containing an invalid UTF-8 byte immediately after ".git"', () => {
    describe('When matching against "git"', () => {
      it('Then it does not match and does not throw', () => {
        // Arrange — a lone continuation-less byte decodes to U+FFFD, which
        // is neither ignorable nor part of the needle, so the HFS fold
        // fails; the NTFS fold fails too since 0xFF is not '.'/' '.
        const sut = matchesDotgitAlias;
        const buf = concatBytes(encode('.git'), Uint8Array.of(0xff));

        // Act
        const result = sut(buf, 0, buf.length, 'git');

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given an entry name embedded in a larger buffer with bytes on both sides', () => {
    describe('When matching only the inner [start, end) span against "git"', () => {
      it('Then only the span content decides the match', () => {
        // Arrange — a fold that reads outside [start, end) would pick up
        // the surrounding "xxx"/"yyy" bytes and fail to match.
        const sut = matchesDotgitAlias;
        const buf = concatBytes(encode('xxx'), encode('.git'), encode('yyy'));

        // Act
        const result = sut(buf, 3, 7, 'git');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given an empty span (start === end)', () => {
    describe('When matching against "git"', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = matchesDotgitAlias;
        const buf = encode('.git');

        // Act
        const result = sut(buf, 0, 0, 'git');

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});
