import { describe, expect, it } from 'vitest';

import { encode, hexToBytes } from '../../../../src/domain/objects/encoding.js';
import { TsgitError } from '../../../../src/domain/objects/error.js';
import { SHA1_CONFIG, SHA256_CONFIG } from '../../../../src/domain/objects/hash-config.js';
import {
  advanceCursor,
  compareCursorNames,
  cursorMode,
  cursorName,
  cursorOid,
  cursorsSame,
  openTreeCursor,
  type TreeCursor,
} from '../../../../src/domain/objects/tree-cursor.js';

const OID_HEX_20_A = 'a'.repeat(40);
const OID_HEX_20_B = 'b'.repeat(40);
const OID_HEX_32_A = 'c'.repeat(64);

function concatBytes(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function entryBytes(mode: string, name: string, oidHex: string = OID_HEX_20_A): Uint8Array {
  return concatBytes(encode(`${mode} ${name}\0`), hexToBytes(oidHex));
}

function singleEntryCursor(mode: string, name: string, oidHex: string = OID_HEX_20_A): TreeCursor {
  return openTreeCursor(entryBytes(mode, name, oidHex), SHA1_CONFIG);
}

function expectInvalidTreeEntry(
  act: () => void,
  expected: { readonly offset: number; readonly reason: string },
): void {
  let caught: unknown;

  try {
    act();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(TsgitError);
  expect((caught as TsgitError).data).toEqual({
    code: 'INVALID_TREE_ENTRY',
    offset: expected.offset,
    reason: expected.reason,
  });
}

describe('tree-cursor', () => {
  describe('openTreeCursor', () => {
    describe('Given a single well-formed entry', () => {
      describe('When opening a cursor over it', () => {
        it("Then cursorName returns the entry's name", () => {
          // Arrange
          const buf = entryBytes('100644', 'a.txt');
          const sut = openTreeCursor;

          // Act
          const cursor = sut(buf, SHA1_CONFIG);
          const result = cursorName(cursor);

          // Assert
          expect(result).toBe('a.txt');
        });
      });
    });

    describe('Given a zero-length buffer (the empty tree)', () => {
      describe('When opening a cursor over it', () => {
        it('Then done is true and there is no current entry', () => {
          // Arrange
          const buf = new Uint8Array(0);
          const sut = openTreeCursor;

          // Act
          const cursor = sut(buf, SHA1_CONFIG);

          // Assert
          expect(cursor.done).toBe(true);
        });
      });
    });

    describe('Given a well-formed entry with a SHA-256 (32-byte) oid', () => {
      describe('When opening a cursor with SHA256_CONFIG', () => {
        it('Then cursorOid returns the 64-hex-char id, proving the width comes from digestLength', () => {
          // Arrange
          const buf = entryBytes('100644', 'a.txt', OID_HEX_32_A);
          const sut = openTreeCursor;

          // Act
          const cursor = sut(buf, SHA256_CONFIG);
          const result = cursorOid(cursor);

          // Assert
          expect(result).toBe(OID_HEX_32_A);
        });
      });
    });
  });

  describe("the structural refusals git's tree decoder enforces", () => {
    describe('Given an entry with no space anywhere after the mode', () => {
      describe('When opening a cursor over it', () => {
        it("Then throws INVALID_TREE_ENTRY 'missing space after mode' at offset 0", () => {
          // Arrange
          const buf = concatBytes(encode('100644a.txt\0'), hexToBytes(OID_HEX_20_A));

          // Act & Assert
          expectInvalidTreeEntry(() => openTreeCursor(buf, SHA1_CONFIG), {
            offset: 0,
            reason: 'missing space after mode',
          });
        });
      });
    });

    describe('Given an entry with a leading space (empty mode)', () => {
      describe('When opening a cursor over it', () => {
        it("Then throws INVALID_TREE_ENTRY 'malformed mode' at offset 0", () => {
          // Arrange
          const buf = concatBytes(encode(' 100644 a.txt\0'), hexToBytes(OID_HEX_20_A));

          // Act & Assert
          expectInvalidTreeEntry(() => openTreeCursor(buf, SHA1_CONFIG), {
            offset: 0,
            reason: 'malformed mode',
          });
        });
      });
    });

    describe('Given an entry with a non-octal digit in the mode', () => {
      describe('When opening a cursor over it', () => {
        it("Then throws INVALID_TREE_ENTRY 'malformed mode' at offset 0", () => {
          // Arrange
          const buf = concatBytes(encode('100648 a.txt\0'), hexToBytes(OID_HEX_20_A));

          // Act & Assert
          expectInvalidTreeEntry(() => openTreeCursor(buf, SHA1_CONFIG), {
            offset: 0,
            reason: 'malformed mode',
          });
        });
      });
    });

    describe('Given an entry with no NUL after the name', () => {
      describe('When opening a cursor over it', () => {
        it("Then throws INVALID_TREE_ENTRY 'missing null after name' at offset 0", () => {
          // Arrange
          const buf = encode('100644 a.txt');

          // Act & Assert
          expectInvalidTreeEntry(() => openTreeCursor(buf, SHA1_CONFIG), {
            offset: 0,
            reason: 'missing null after name',
          });
        });
      });
    });

    describe('Given an entry with an empty name', () => {
      describe('When opening a cursor over it', () => {
        it("Then throws INVALID_TREE_ENTRY 'empty filename' at offset 0", () => {
          // Arrange
          const buf = concatBytes(encode('100644 \0'), hexToBytes(OID_HEX_20_A));

          // Act & Assert
          expectInvalidTreeEntry(() => openTreeCursor(buf, SHA1_CONFIG), {
            offset: 0,
            reason: 'empty filename',
          });
        });
      });
    });

    describe('Given an entry whose oid is shorter than the digest length', () => {
      describe('When opening a cursor over it', () => {
        it("Then throws INVALID_TREE_ENTRY 'truncated hash' at offset 0", () => {
          // Arrange
          const buf = concatBytes(
            encode('100644 a.txt\0'),
            hexToBytes(OID_HEX_20_A).subarray(0, 10),
          );

          // Act & Assert
          expectInvalidTreeEntry(() => openTreeCursor(buf, SHA1_CONFIG), {
            offset: 0,
            reason: 'truncated hash',
          });
        });
      });
    });

    describe('Given a well-formed entry followed by trailing junk with no space', () => {
      describe('When advancing the cursor past the first entry', () => {
        it("Then throws INVALID_TREE_ENTRY 'missing space after mode' at the junk's offset", () => {
          // Arrange
          const firstEntry = entryBytes('100644', 'a.txt');
          const buf = concatBytes(firstEntry, encode('xx'));
          const cursor = openTreeCursor(buf, SHA1_CONFIG);

          // Act & Assert
          expectInvalidTreeEntry(() => advanceCursor(cursor), {
            offset: firstEntry.length,
            reason: 'missing space after mode',
          });
        });
      });
    });
  });

  describe('isDir', () => {
    describe('Given the byte range of a mode', () => {
      describe('When opening a cursor over the entry', () => {
        it.each([
          { mode: '40000', expected: true, label: "'40000' is a directory (L === 5 branch)" },
          { mode: '040000', expected: true, label: "'040000' is a directory" },
          { mode: '40644', expected: true, label: "'40644' is a directory" },
          {
            mode: '1040000',
            expected: true,
            label: "'1040000' is a directory (L > 6, even 8^5 digit)",
          },
          { mode: '100644', expected: false, label: "'100644' is not a directory" },
          { mode: '100755', expected: false, label: "'100755' is not a directory" },
          { mode: '120000', expected: false, label: "'120000' is not a directory" },
          { mode: '160000', expected: false, label: "'160000' is not a directory" },
          {
            mode: '0100644',
            expected: false,
            label: "'0100644' is not a directory (wrong 8^4 digit)",
          },
          {
            mode: '140000',
            expected: false,
            label: "'140000' is not a directory (right 8^4 digit, odd 8^5 digit)",
          },
        ])('Then $label', ({ mode, expected }) => {
          // Arrange
          const cursor = singleEntryCursor(mode, 'a');

          // Act & Assert
          expect(cursor.isDir).toBe(expected);
        });
      });
    });

    describe('Given a length-4 mode as the SECOND entry, immediately after an oid whose final byte is 0x34', () => {
      describe('When opening a cursor at the second entry', () => {
        it('Then isDir is false (the length < 5 short-circuit fires before the coincidental byte match)', () => {
          // Arrange — a `||`→`&&` mutant would need BOTH `length < 5` and a
          // 0x34 byte at modeEnd-5 to fall through; planting that coincidental
          // byte in the PRECEDING entry's oid (which modeEnd-5 lands on, since
          // this mode is only 4 bytes long) proves the short-circuit alone
          // decides the verdict, not a lucky byte match.
          const precedingOidHex = `${'a'.repeat(38)}34`;
          const first = entryBytes('100644', 'a', precedingOidHex);
          const second = entryBytes('4000', 'b');
          const buf = concatBytes(first, second);
          const cursor = openTreeCursor(buf, SHA1_CONFIG);

          // Act
          advanceCursor(cursor);

          // Assert
          expect(cursor.isDir).toBe(false);
        });
      });
    });
  });

  describe('compareCursorNames', () => {
    describe('Given the virtual trailing-slash sort order (d-dash < d.txt < d/ < d0)', () => {
      describe('When comparing adjacent pairs', () => {
        it('Then each pair orders as git does', () => {
          // Arrange
          const dDash = singleEntryCursor('100644', 'd-dash');
          const dTxt = singleEntryCursor('100644', 'd.txt');
          const dTree = singleEntryCursor('40000', 'd');
          const dZero = singleEntryCursor('100644', 'd0');
          const sut = compareCursorNames;

          // Act & Assert
          expect(sut(dDash, dTxt)).toBeLessThan(0);
          expect(sut(dTxt, dTree)).toBeLessThan(0);
          expect(sut(dTree, dZero)).toBeLessThan(0);
        });
      });
    });

    describe('Given the same name as both a directory and a blob', () => {
      describe('When comparing', () => {
        it("Then the directory (virtual 'd/') sorts after the blob 'd'", () => {
          // Arrange
          const dBlob = singleEntryCursor('100644', 'd');
          const dTree = singleEntryCursor('40000', 'd');
          const sut = compareCursorNames;

          // Act
          const result = sut(dTree, dBlob);

          // Assert
          expect(result).toBeGreaterThan(0);
        });
      });
    });

    describe('Given a shorter name that is a prefix of a longer one', () => {
      describe('When comparing', () => {
        it("Then 'ab' sorts before 'abc'", () => {
          // Arrange
          const ab = singleEntryCursor('100644', 'ab');
          const abc = singleEntryCursor('100644', 'abc');
          const sut = compareCursorNames;

          // Act
          const result = sut(ab, abc);

          // Assert
          expect(result).toBeLessThan(0);
        });
      });
    });

    describe("Given a blob 'd' and a blob 'd!' (identical shared-prefix byte, diverging length)", () => {
      describe('When comparing', () => {
        it("Then 'd' sorts before 'd!' via the virtual slash on the exhausted shorter side", () => {
          // Arrange — a Math.max mutant would extend the compare loop past the
          // shorter name's real length into VIRTUAL_SLASH ('/' = 0x2f), which
          // sorts AFTER '!' (0x21), flipping the verdict to positive.
          const d = singleEntryCursor('100644', 'd');
          const dBang = singleEntryCursor('100644', 'd!');
          const sut = compareCursorNames;

          // Act
          const result = sut(d, dBang);

          // Assert
          expect(result).toBeLessThan(0);
        });
      });
    });

    describe('Given two entries with the identical name and mode', () => {
      describe('When comparing', () => {
        it('Then returns 0', () => {
          // Arrange
          const a = singleEntryCursor('100644', 'a.txt');
          const b = singleEntryCursor('100644', 'a.txt');
          const sut = compareCursorNames;

          // Act
          const result = sut(a, b);

          // Assert
          expect(result).toBe(0);
        });
      });
    });
  });

  describe('cursorsSame', () => {
    describe('Given two entries with the same mode but a different oid', () => {
      describe('When comparing', () => {
        it('Then returns false', () => {
          // Arrange
          const a = singleEntryCursor('100644', 'a.txt', OID_HEX_20_A);
          const b = singleEntryCursor('100644', 'a.txt', OID_HEX_20_B);
          const sut = cursorsSame;

          // Act
          const result = sut(a, b);

          // Assert
          expect(result).toBe(false);
        });
      });
    });

    describe('Given two entries with the same oid but a different mode', () => {
      describe('When comparing', () => {
        it('Then returns false', () => {
          // Arrange
          const a = singleEntryCursor('100644', 'a.txt');
          const b = singleEntryCursor('100755', 'a.txt');
          const sut = cursorsSame;

          // Act
          const result = sut(a, b);

          // Assert
          expect(result).toBe(false);
        });
      });
    });

    describe('Given the same oid and modes whose stripped byte lengths differ', () => {
      describe('When comparing', () => {
        it('Then returns false without a byte-by-byte scan', () => {
          // Arrange
          const a = singleEntryCursor('644', 'a.txt');
          const b = singleEntryCursor('100644', 'a.txt');
          const sut = cursorsSame;

          // Act
          const result = sut(a, b);

          // Assert
          expect(result).toBe(false);
        });
      });
    });

    describe('Given the same oid and a mode differing only by a leading zero (40000 vs 040000)', () => {
      describe('When comparing', () => {
        it('Then returns true (leading-zero-stripped mode equality)', () => {
          // Arrange
          const a = singleEntryCursor('40000', 'd');
          const b = singleEntryCursor('040000', 'd');
          const sut = cursorsSame;

          // Act
          const result = sut(a, b);

          // Assert
          expect(result).toBe(true);
        });
      });
    });

    describe('Given two entries with the same oid and the same mode', () => {
      describe('When comparing', () => {
        it('Then returns true', () => {
          // Arrange
          const a = singleEntryCursor('100644', 'a.txt');
          const b = singleEntryCursor('100644', 'z.txt');
          const sut = cursorsSame;

          // Act
          const result = sut(a, b);

          // Assert
          expect(result).toBe(true);
        });
      });
    });
  });

  describe('cursorMode', () => {
    describe('Given a well-formed entry', () => {
      describe('When reading its mode', () => {
        it("Then returns the interned FileMode constant for '100644'", () => {
          // Arrange
          const cursor = singleEntryCursor('100644', 'a.txt');
          const sut = cursorMode;

          // Act
          const result = sut(cursor);

          // Assert
          expect(result).toBe('100644');
        });
      });
    });
  });
});
