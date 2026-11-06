import { describe, expect, it } from 'vitest';

import { encode } from '../../../../src/domain/objects/encoding.js';
import {
  backslashSegmentStarts,
  entryNameKey,
  hasNonOctalByte,
  matchesDotgitAlias,
  matchesNtfsDotgitAlias,
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

  describe.each([
    { label: 'FF', tail: [0xff] },
    { label: 'FE', tail: [0xfe] },
    { label: 'F8 80 80 80 80', tail: [0xf8, 0x80, 0x80, 0x80, 0x80] },
    { label: 'a lone continuation 80', tail: [0x80] },
    { label: 'overlong C0 80', tail: [0xc0, 0x80] },
    { label: 'overlong C1 BF', tail: [0xc1, 0xbf] },
    { label: 'a two-byte lead truncated at the span end', tail: [0xc2] },
    { label: 'E2 80 truncated', tail: [0xe2, 0x80] },
    { label: 'E2 80 41', tail: [0xe2, 0x80, 0x41] },
    { label: 'E2 C0 8C', tail: [0xe2, 0xc0, 0x8c] },
    { label: 'E2 78', tail: [0xe2, 0x78] },
    { label: 'overlong E0 80 AF', tail: [0xe0, 0x80, 0xaf] },
    { label: 'E0 80', tail: [0xe0, 0x80] },
    { label: 'surrogate ED A0 80', tail: [0xed, 0xa0, 0x80] },
    { label: 'EF BF BE', tail: [0xef, 0xbf, 0xbe] },
    { label: 'EF BF BF', tail: [0xef, 0xbf, 0xbf] },
    { label: 'F0 9F 98 41', tail: [0xf0, 0x9f, 0x98, 0x41] },
    { label: 'overlong F0 80 80 80', tail: [0xf0, 0x80, 0x80, 0x80] },
    { label: 'beyond-range F4 90 80 80', tail: [0xf4, 0x90, 0x80, 0x80] },
    { label: 'F5 80 80 80', tail: [0xf5, 0x80, 0x80, 0x80] },
    { label: 'two rejected bytes (first ends the read)', tail: [0xff, 0xff] },
    { label: 'an ignorable then a rejected byte', tail: [0xe2, 0x80, 0x8c, 0xff] },
    { label: 'a rejected byte then an ignorable (rest unread)', tail: [0xff, 0xe2, 0x80, 0x8c] },
  ])("Given '.git' followed by $label, a sequence git's UTF-8 picker rejects", ({ tail }) => {
    describe('When matched against "git"', () => {
      it('Then it matches', () => {
        // Arrange
        const sut = matchesDotgitAlias;
        const buf = concatBytes(encode('.git'), Uint8Array.of(...tail));

        // Act
        const result = sut(buf, 0, buf.length, 'git');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe.each([
    { label: 'upper-case needle then FF', parts: [encode('.GIT'), Uint8Array.of(0xff)] },
    {
      label: 'an ignorable inside the needle then FF',
      parts: [encode('.gi'), U200C, encode('t'), Uint8Array.of(0xff)],
    },
    {
      label: 'an ignorable between the dot and the name then FF',
      parts: [encode('.'), U200C, encode('GIT'), Uint8Array.of(0xff)],
    },
    { label: 'a leading ignorable then FF', parts: [U200C, encode('.git'), Uint8Array.of(0xff)] },
    {
      label: 'an ignorable inside the needle then 80',
      parts: [encode('.g'), U200C, encode('it'), Uint8Array.of(0x80)],
    },
  ])('Given $label', ({ parts }) => {
    describe('When matched against "git"', () => {
      it('Then it matches', () => {
        // Arrange
        const sut = matchesDotgitAlias;
        const buf = concatBytes(...parts);

        // Act
        const result = sut(buf, 0, buf.length, 'git');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe.each(['gitmodules', 'gitattributes', 'gitignore', 'mailmap'] as const)(
    'Given ".%s" followed by a byte git rejects',
    (alias) => {
      describe('When matched against its own alias', () => {
        it('Then it matches', () => {
          // Arrange
          const sut = matchesDotgitAlias;
          const buf = concatBytes(encode(`.${alias}`), Uint8Array.of(0xff));

          // Act
          const result = sut(buf, 0, buf.length, alias);

          // Assert
          expect(result).toBe(true);
        });
      });
    },
  );

  describe.each([
    { label: 'C3 A9', tail: [0xc3, 0xa9] },
    { label: 'C2 80', tail: [0xc2, 0x80] },
    { label: 'E0 A0 80', tail: [0xe0, 0xa0, 0x80] },
    { label: 'E2 98 83', tail: [0xe2, 0x98, 0x83] },
    { label: 'ED 9F BF', tail: [0xed, 0x9f, 0xbf] },
    { label: 'EF BE BF', tail: [0xef, 0xbe, 0xbf] },
    { label: 'a literal U+FFFD', tail: [0xef, 0xbf, 0xbd] },
    { label: 'F0 90 80 80', tail: [0xf0, 0x90, 0x80, 0x80] },
    { label: 'F0 9F 98 80', tail: [0xf0, 0x9f, 0x98, 0x80] },
    { label: 'F4 8F BF BF', tail: [0xf4, 0x8f, 0xbf, 0xbf] },
    {
      label: 'F2 80 8C 80, whose first three bytes compute to U+200C',
      tail: [0xf2, 0x80, 0x8c, 0x80],
    },
    { label: 'the ASCII letter x', tail: [0x78] },
  ])("Given '.git' followed by $label, a sequence git's picker accepts", ({ tail }) => {
    describe('When matched against "git"', () => {
      it('Then it does not match', () => {
        // Arrange
        const sut = matchesDotgitAlias;
        const buf = concatBytes(encode('.git'), Uint8Array.of(...tail));

        // Act
        const result = sut(buf, 0, buf.length, 'git');

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe.each([
    {
      label: 'a rejected byte inside the needle',
      parts: [encode('.g'), Uint8Array.of(0xff), encode('it')],
    },
    {
      label: 'a rejected sequence computing to U+200C inside the needle',
      parts: [encode('.g'), Uint8Array.of(0xe2, 0xc0, 0x8c), encode('it')],
    },
    {
      label:
        'a valid four-byte character whose first three bytes compute to U+200C inside the needle',
      parts: [encode('.g'), Uint8Array.of(0xf2, 0x80, 0x8c, 0x80), encode('it')],
    },
    {
      label: 'a rejected byte right after the dot',
      parts: [encode('.'), Uint8Array.of(0xff), encode('git')],
    },
    { label: 'a rejected byte before the dot', parts: [Uint8Array.of(0xff), encode('.git')] },
  ])('Given $label', ({ parts }) => {
    describe('When matched against "git"', () => {
      it('Then it does not match', () => {
        // Arrange
        const sut = matchesDotgitAlias;
        const buf = concatBytes(...parts);

        // Act
        const result = sut(buf, 0, buf.length, 'git');

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a span ending inside a three-byte sequence whose rest lies past the end', () => {
    describe('When only [start, end) is matched against "git"', () => {
      it('Then it matches, as git reads the truncated sequence as the end of the name', () => {
        // Arrange
        const sut = matchesDotgitAlias;
        const buf = concatBytes(encode('.git'), Uint8Array.of(0xe2, 0x98, 0x83));

        // Act
        const result = sut(buf, 0, 5, 'git');

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

  describe('Given a span too short for the "git" short name, embedded in a larger buffer', () => {
    describe('When matching against "git"', () => {
      it('Then it does not match (bytes past the span end must not be read)', () => {
        // Arrange — a length computed from the wrong ends, or a length gate
        // that is bypassed, would let this read the "~1" that sits just past
        // `end` and falsely match.
        const sut = matchesDotgitAlias;
        const buf = concatBytes(encode('xxx'), encode('git~1'), encode('yyy'));

        // Act
        const result = sut(buf, 3, 6, 'git');

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a span too short for the NTFS short name, embedded in a larger buffer', () => {
    describe('When matching against "gitmodules"', () => {
      it('Then it does not match (bytes past the span end must not be read)', () => {
        // Arrange — same class of bug as above, for the generic (non-"git")
        // short-name fold: a bypassed or widened length gate lets the tilde,
        // digit, and trailing-dots checks read past `end` into "~1".
        const sut = matchesDotgitAlias;
        const buf = concatBytes(encode('xxx'), encode('gitmod~1'), encode('yyy'));

        // Act
        const result = sut(buf, 3, 9, 'gitmodules');

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given an NTFS short name missing its tilde', () => {
    describe('When matching against "gitmodules"', () => {
      it('Then gitmodX1 does not match', () => {
        // Arrange
        const sut = matchesDotgitAlias;
        const buf = encode('gitmodX1');

        // Act
        const result = sut(buf, 0, buf.length, 'gitmodules');

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given an NTFS short name whose digit is below the accepted 1-4 range', () => {
    describe('When matching against "gitmodules"', () => {
      it('Then gitmod~0 does not match', () => {
        // Arrange
        const sut = matchesDotgitAlias;
        const buf = encode('gitmod~0');

        // Act
        const result = sut(buf, 0, buf.length, 'gitmodules');

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given the NTFS short name at the upper end of the accepted digit range', () => {
    describe('When matching against "gitmodules"', () => {
      it('Then gitmod~4 matches', () => {
        // Arrange
        const sut = matchesDotgitAlias;
        const buf = encode('gitmod~4');

        // Act
        const result = sut(buf, 0, buf.length, 'gitmodules');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a name holding a byte git\'s UTF-8 reader rejects immediately after ".git"', () => {
    describe('When matching against "git"', () => {
      it('Then it matches without throwing, as git reads the rejected byte as the end of the name', () => {
        // Arrange — git 2.56.0 fsck reports hasDotgit for ".git" + 0xFF: its
        // UTF-8 picker rejects the byte, which ends the name.
        const sut = matchesDotgitAlias;
        const buf = concatBytes(encode('.git'), Uint8Array.of(0xff));

        // Act
        const result = sut(buf, 0, buf.length, 'git');

        // Assert
        expect(result).toBe(true);
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

describe('Given names git 2.55.0 reads as NTFS aliases of a dotgit file', () => {
  describe.each([
    { name: '.git:stream', alias: 'git', expected: true },
    { name: 'git~1:stream', alias: 'git', expected: true },
    { name: '.git\\x', alias: 'git', expected: true },
    { name: '.git/x', alias: 'git', expected: true },
    { name: '.git.x', alias: 'git', expected: false },
    { name: '.gitmodules:stream', alias: 'gitmodules', expected: true },
    { name: '.gitmodules. :x', alias: 'gitmodules', expected: true },
    { name: '.gitmodules\\b', alias: 'gitmodules', expected: false },
    { name: 'GI7EBA~2', alias: 'gitmodules', expected: true },
    { name: 'gi7eba~9. ', alias: 'gitmodules', expected: true },
    { name: 'gi7eb~12', alias: 'gitmodules', expected: true },
    { name: 'g~123456', alias: 'gitmodules', expected: true },
    { name: '~1234567', alias: 'gitmodules', expected: true },
    { name: 'gi7eba~0', alias: 'gitmodules', expected: false },
    { name: 'gi7eba~1x', alias: 'gitmodules', expected: false },
    { name: 'gi7eb~1x', alias: 'gitmodules', expected: false },
    { name: 'gi7eba7~1', alias: 'gitmodules', expected: false },
    { name: 'gi7eba~', alias: 'gitmodules', expected: false },
    { name: 'gi7ebx~1', alias: 'gitmodules', expected: false },
    { name: 'gi7d29~1', alias: 'gitattributes', expected: true },
    { name: 'gi250a~1', alias: 'gitignore', expected: true },
    { name: 'maba30~1', alias: 'mailmap', expected: true },
    { name: 'gi7d29~1', alias: 'gitmodules', expected: false },
  ] as const)('When $name is matched against the $alias alias', ({ name, alias, expected }) => {
    it(`Then it resolves to ${expected}`, () => {
      // Arrange
      const sut = matchesDotgitAlias;
      const nameBytes = encode(name);

      // Act
      const result = sut(nameBytes, 0, nameBytes.length, alias);

      // Assert
      expect(result).toBe(expected);
    });
  });
});

describe('Given a name that is a dotgit alias only under the HFS fold', () => {
  describe('When it is matched against the NTFS rule alone', () => {
    it('Then it does not match', () => {
      // Arrange
      const sut = matchesNtfsDotgitAlias;
      const nameBytes = concatBytes(encode('.git'), U200C, encode('modules'));

      // Act
      const result = sut(nameBytes, 0, nameBytes.length, 'gitmodules');

      // Assert
      expect(result).toBe(false);
    });
  });
});

describe('Given a name that is an NTFS short-name alias inside a wider buffer', () => {
  describe('When only the name range is matched', () => {
    it('Then bytes past the range never complete the short name', () => {
      // Arrange
      const sut = matchesNtfsDotgitAlias;
      const buffer = encode('gi7eb~1234');

      // Act
      const result = sut(buffer, 0, 7, 'gitmodules');

      // Assert
      expect(result).toBe(false);
    });
  });
});

describe('Given a range too short for the dot form, embedded in a buffer that completes it', () => {
  describe('When only the range is matched against "git"', () => {
    it('Then bytes past the range never complete the dot form', () => {
      // Arrange
      const sut = matchesNtfsDotgitAlias;
      const buffer = encode('xxx.git');

      // Act
      const result = sut(buffer, 3, 5, 'git');

      // Assert
      expect(result).toBe(false);
    });
  });
});

describe('backslashSegmentStarts', () => {
  describe('Given a range holding one backslash, with another just past its end', () => {
    describe('When the segment starts are listed', () => {
      it('Then only the byte after the inner backslash starts a segment', () => {
        // Arrange
        const sut = backslashSegmentStarts;
        const buffer = encode('a\\b\\');

        // Act
        const result = sut(buffer, 0, 3);

        // Assert
        expect(result).toEqual([2]);
      });
    });
  });
});
