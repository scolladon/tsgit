import { describe, expect, it } from 'vitest';

import { encode } from '../../../../src/domain/objects/encoding.js';
import { SHA1_CONFIG, SHA256_CONFIG } from '../../../../src/domain/objects/hash-config.js';
import { ObjectId } from '../../../../src/domain/objects/object-id.js';
import type { TreeEntry } from '../../../../src/domain/objects/tree.js';
import {
  parseTreeContent,
  serializeTreeContent,
  sortTreeEntries,
  treeEntry,
  treeEntryCompare,
} from '../../../../src/domain/objects/tree.js';

const DUMMY_ID = ObjectId.from('a'.repeat(40));

function buildTreeEntry(mode: string, name: string | Uint8Array, sha: Uint8Array): Uint8Array {
  const modeBytes = encode(mode);
  const nameBytes = typeof name === 'string' ? encode(name) : name;
  const result = new Uint8Array(modeBytes.length + 1 + nameBytes.length + 1 + sha.length);
  result.set(modeBytes, 0);
  result[modeBytes.length] = 0x20; // space
  result.set(nameBytes, modeBytes.length + 1);
  result[modeBytes.length + 1 + nameBytes.length] = 0x00; // null
  result.set(sha, modeBytes.length + 1 + nameBytes.length + 1);
  return result;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

describe('tree', () => {
  describe('treeEntry', () => {
    describe('Given a mode, a name and an id', () => {
      describe('When treeEntry mints an entry', () => {
        it('Then the entry carries them verbatim', () => {
          // Arrange
          const sut = treeEntry;
          const mode = '100644' as const;
          const name = 'hello.txt';
          const id = DUMMY_ID;

          // Act
          const result = sut(mode, name, id);

          // Assert
          expect(result.mode).toBe(mode);
          expect(result.name).toBe(name);
          expect(result.id).toBe(id);
        });
      });
    });

    describe('Given the same ASCII name as a string and as raw bytes', () => {
      describe('When treeEntry mints both', () => {
        it('Then both entries carry identical mode, name and nameBytes', () => {
          // Arrange
          const bytes = encode('hello.txt');

          // Act
          const fromString = treeEntry('100644', 'hello.txt', DUMMY_ID);
          const fromBytes = treeEntry('100644', bytes, DUMMY_ID);

          // Assert
          expect(fromBytes.name).toBe(fromString.name);
          expect(fromBytes.nameBytes).toEqual(fromString.nameBytes);
        });
      });
    });

    describe('Given a name of raw bytes carrying a byte-order mark', () => {
      describe('When treeEntry mints an entry from those bytes', () => {
        it('Then name preserves the BOM instead of stripping it', () => {
          // Arrange
          const bomBytes = Uint8Array.of(0xef, 0xbb, 0xbf, 0x61);

          // Act
          const result = treeEntry('100644', bomBytes, DUMMY_ID);

          // Assert
          expect(result.name).toBe('﻿a');
          expect(result.nameBytes).toEqual(bomBytes);
        });
      });
    });

    describe('Given a name of raw bytes that is not valid UTF-8', () => {
      describe('When treeEntry mints an entry from those bytes', () => {
        it('Then name decodes to the replacement character while nameBytes keeps the original byte', () => {
          // Arrange
          const invalidBytes = Uint8Array.of(0xff);

          // Act
          const result = treeEntry('100644', invalidBytes, DUMMY_ID);

          // Assert
          expect(result.name).toBe('�');
          expect(result.nameBytes).toEqual(Uint8Array.of(0xff));
        });
      });
    });

    describe('Given a caller-supplied Uint8Array used to mint an entry', () => {
      describe('When the caller mutates that array afterwards', () => {
        it('Then the entry keeps its own copy, unaffected by the mutation', () => {
          // Arrange
          const callerBytes = Uint8Array.of(0x61); // 'a'
          const result = treeEntry('100644', callerBytes, DUMMY_ID);

          // Act
          callerBytes[0] = 0x62; // mutate to 'b' after construction

          // Assert
          expect(result.nameBytes).toEqual(Uint8Array.of(0x61));
          expect(result.name).toBe('a');
        });
      });
    });
  });

  describe('parseTreeContent', () => {
    describe("Given a single entry '100644 hello.txt\\\\0<20-byte-sha>'", () => {
      describe('When parsing with SHA1_CONFIG', () => {
        it("Then mode='100644', name='hello.txt', id=hex of sha", () => {
          // Arrange
          const sha = new Uint8Array(20).fill(0xab);
          const content = buildTreeEntry('100644', 'hello.txt', sha);

          // Act
          const result = parseTreeContent(DUMMY_ID, content, SHA1_CONFIG);

          // Assert
          expect(result.entries).toHaveLength(1);
          expect(result.entries[0]!.mode).toBe('100644');
          expect(result.entries[0]!.name).toBe('hello.txt');
          expect(result.entries[0]!.id).toBe('ab'.repeat(20));
        });
      });
    });

    describe('Given multiple entries concatenated', () => {
      describe('When parsing', () => {
        it('Then returns all entries in order', () => {
          // Arrange
          const sha1 = new Uint8Array(20).fill(0x01);
          const sha2 = new Uint8Array(20).fill(0x02);
          const content = concatBytes(
            buildTreeEntry('100644', 'a.txt', sha1),
            buildTreeEntry('100755', 'b.sh', sha2),
          );

          // Act
          const result = parseTreeContent(DUMMY_ID, content, SHA1_CONFIG);

          // Assert
          expect(result.entries).toHaveLength(2);
          expect(result.entries[0]!.name).toBe('a.txt');
          expect(result.entries[1]!.name).toBe('b.sh');
        });
      });
    });

    describe("Given directory mode '40000' in bytes", () => {
      describe('When parsing', () => {
        it("Then mode is '40000' (not '040000')", () => {
          // Arrange
          const sha = new Uint8Array(20).fill(0xcc);
          const content = buildTreeEntry('40000', 'subdir', sha);

          // Act
          const result = parseTreeContent(DUMMY_ID, content, SHA1_CONFIG);

          // Assert
          expect(result.entries[0]!.mode).toBe('40000');
        });
      });
    });

    describe('Given an entry name with a distinguishing character class', () => {
      describe('When parsing', () => {
        it.each([
          { name: '日本語.txt', label: 'non-ASCII UTF-8 is correctly decoded' },
          { name: 'my file.txt', label: 'an internal space is included' },
          {
            name: 'x',
            label: 'a single char is correctly extracted (the null search starts after the space)',
          },
        ])('Then $label', ({ name }) => {
          // Arrange
          const sha = new Uint8Array(20).fill(0xdd);
          const content = buildTreeEntry('100644', name, sha);

          // Act
          const result = parseTreeContent(DUMMY_ID, content, SHA1_CONFIG);

          // Assert
          expect(result.entries[0]!.name).toBe(name);
        });
      });
    });

    describe('Given SHA-256 tree (32-byte hashes)', () => {
      describe('When parsing with SHA256_CONFIG', () => {
        it('Then ObjectIds are 64-char hex', () => {
          // Arrange
          const sha = new Uint8Array(32).fill(0xff);
          const content = buildTreeEntry('100644', 'file.txt', sha);

          // Act
          const result = parseTreeContent(DUMMY_ID, content, SHA256_CONFIG);

          // Assert
          expect(result.entries[0]!.id.length).toBe(64);
        });
      });
    });

    // Each row isolates one distinct parseTreeContent validation guard — the
    // structural parse guards (space/hash/null), the four `invalid entry name`
    // conditions, and the post-parse duplicate-name check.
    describe('Given content that fails a parseTreeContent validation guard', () => {
      describe('When parsing', () => {
        it.each([
          {
            label: 'no space after mode',
            reason: 'missing space after mode',
            offset: 0,
            buildContent: () => new Uint8Array([49, 48, 48, 54, 52, 52]), // "100644" without space
          },
          {
            label: 'a non-octal mode byte',
            reason: 'malformed mode',
            offset: 0,
            buildContent: () => buildTreeEntry('10064a', 'foo', new Uint8Array(20).fill(0xab)),
          },
          {
            label: 'an empty mode',
            reason: 'malformed mode',
            offset: 0,
            buildContent: () => buildTreeEntry(' 100644', 'foo', new Uint8Array(20).fill(0xab)),
          },
          {
            label: 'content truncated mid-hash',
            reason: 'truncated hash',
            offset: 0,
            buildContent: () =>
              concatBytes(
                encode('100644'),
                new Uint8Array([0x20]),
                encode('file'),
                new Uint8Array([0x00]),
                new Uint8Array(10), // only 10 bytes, need 20
              ),
          },
          {
            label: 'no null after name',
            reason: 'missing null after name',
            offset: 0,
            buildContent: () => encode('100644 filename'),
          },
          {
            label: 'an empty entry name',
            reason: 'empty filename',
            offset: 0,
            buildContent: () => buildTreeEntry('100644', '', new Uint8Array(20).fill(0xab)),
          },
        ])('Then throws INVALID_TREE_ENTRY for $label', ({ buildContent, reason, offset }) => {
          // Arrange
          const content = buildContent();

          // Act + Assert
          expect(() => parseTreeContent(DUMMY_ID, content, SHA1_CONFIG)).toThrow(
            expect.objectContaining({
              data: expect.objectContaining({
                code: 'INVALID_TREE_ENTRY',
                reason,
                offset,
              }),
            }),
          );
        });

        it('Then throws INVALID_TREE_ENTRY reporting the mode fault when both the mode and the name are malformed', () => {
          // Arrange — a non-octal mode byte AND a name of '.': the mode scan
          // runs before the name is ever inspected, so the mode fault wins.
          const content = buildTreeEntry('10064a', '.', new Uint8Array(20).fill(0xab));

          // Act + Assert
          expect(() => parseTreeContent(DUMMY_ID, content, SHA1_CONFIG)).toThrow(
            expect.objectContaining({
              data: expect.objectContaining({
                code: 'INVALID_TREE_ENTRY',
                reason: 'malformed mode',
                offset: 0,
              }),
            }),
          );
        });
      });
    });

    describe('Given an entry name that the parse tier no longer refuses', () => {
      describe('When parsing a tree containing exactly that name', () => {
        it.each([
          {
            label: "a byte-order mark followed by 'a'",
            nameBytes: Uint8Array.of(0xef, 0xbb, 0xbf, 0x61),
            name: '﻿a',
          },
          {
            label: 'a bare byte-order mark',
            nameBytes: Uint8Array.of(0xef, 0xbb, 0xbf),
            name: '﻿',
          },
          {
            label: "a byte-order mark followed by '.'",
            nameBytes: Uint8Array.of(0xef, 0xbb, 0xbf, 0x2e),
            name: '﻿.',
          },
          {
            label: "a byte-order mark followed by '..'",
            nameBytes: Uint8Array.of(0xef, 0xbb, 0xbf, 0x2e, 0x2e),
            name: '﻿..',
          },
          {
            label: "exactly '.'",
            nameBytes: Uint8Array.of(0x2e),
            name: '.',
          },
          {
            label: "exactly '..'",
            nameBytes: Uint8Array.of(0x2e, 0x2e),
            name: '..',
          },
          {
            label: "an embedded '/' ('a/b')",
            nameBytes: encode('a/b'),
            name: 'a/b',
          },
        ])(
          'Then $label is accepted, carrying its exact nameBytes and derived name',
          ({ nameBytes, name }) => {
            // Arrange
            const sha = new Uint8Array(20).fill(0x07);
            const content = buildTreeEntry('100644', nameBytes, sha);

            // Act
            const result = parseTreeContent(DUMMY_ID, content, SHA1_CONFIG);

            // Assert
            expect(result.entries).toHaveLength(1);
            expect(result.entries[0]!.nameBytes).toEqual(nameBytes);
            expect(result.entries[0]!.name).toBe(name);
          },
        );
      });
    });

    describe('Given a tree with two entries whose raw bytes are each invalid UTF-8 on their own', () => {
      describe('When parsing', () => {
        it('Then both are accepted as two distinct entries, not collapsed by their shared replacement-character decode', () => {
          // Arrange
          const content = concatBytes(
            buildTreeEntry('100644', Uint8Array.of(0xfe), new Uint8Array(20).fill(0x01)),
            buildTreeEntry('100644', Uint8Array.of(0xff), new Uint8Array(20).fill(0x02)),
          );

          // Act
          const result = parseTreeContent(DUMMY_ID, content, SHA1_CONFIG);

          // Assert
          expect(result.entries).toHaveLength(2);
          expect(result.entries[0]!.nameBytes).toEqual(Uint8Array.of(0xfe));
          expect(result.entries[1]!.nameBytes).toEqual(Uint8Array.of(0xff));
          expect(result.entries[0]!.name).toBe('�');
          expect(result.entries[1]!.name).toBe('�');
        });
      });
    });

    describe('Given a tree with both a plain name and its byte-order-mark-prefixed twin', () => {
      describe('When parsing', () => {
        it('Then both are accepted as two distinct entries', () => {
          // Arrange
          const content = concatBytes(
            buildTreeEntry('100644', 'a', new Uint8Array(20).fill(0x01)),
            buildTreeEntry(
              '100644',
              Uint8Array.of(0xef, 0xbb, 0xbf, 0x61),
              new Uint8Array(20).fill(0x02),
            ),
          );

          // Act
          const result = parseTreeContent(DUMMY_ID, content, SHA1_CONFIG);

          // Assert
          expect(result.entries).toHaveLength(2);
          expect(result.entries[0]!.nameBytes).toEqual(encode('a'));
          expect(result.entries[1]!.nameBytes).toEqual(Uint8Array.of(0xef, 0xbb, 0xbf, 0x61));
        });
      });
    });

    describe('Given a tree with two entries sharing the same name but different ids', () => {
      describe('When parsing', () => {
        it('Then both entries are kept — a duplicate name is no longer refused', () => {
          // Arrange
          const content = concatBytes(
            buildTreeEntry('100644', 'a', new Uint8Array(20).fill(0x01)),
            buildTreeEntry('100644', 'a', new Uint8Array(20).fill(0x02)),
          );

          // Act
          const result = parseTreeContent(DUMMY_ID, content, SHA1_CONFIG);

          // Assert
          expect(result.entries).toHaveLength(2);
          expect(result.entries[0]!.name).toBe('a');
          expect(result.entries[1]!.name).toBe('a');
          expect(result.entries[0]!.id).not.toBe(result.entries[1]!.id);
        });
      });
    });

    describe('Given a tree containing every previously-refused byte class in ascending raw-byte order', () => {
      describe('When parsing then re-serializing', () => {
        it('Then the output bytes are identical to the input', () => {
          // Arrange — 'a' < bare BOM < BOM+'a' < FE < FF, ascending raw-byte order
          const content = concatBytes(
            buildTreeEntry('100644', 'a', new Uint8Array(20).fill(0x01)),
            buildTreeEntry(
              '100644',
              Uint8Array.of(0xef, 0xbb, 0xbf),
              new Uint8Array(20).fill(0x02),
            ),
            buildTreeEntry(
              '100644',
              Uint8Array.of(0xef, 0xbb, 0xbf, 0x61),
              new Uint8Array(20).fill(0x03),
            ),
            buildTreeEntry('100644', Uint8Array.of(0xfe), new Uint8Array(20).fill(0x04)),
            buildTreeEntry('100644', Uint8Array.of(0xff), new Uint8Array(20).fill(0x05)),
          );
          const tree = parseTreeContent(DUMMY_ID, content, SHA1_CONFIG);

          // Act
          const result = serializeTreeContent(tree, SHA1_CONFIG);

          // Assert
          expect(result).toEqual(content);
        });
      });
    });

    describe('Given empty content (0 bytes)', () => {
      describe('When parsing', () => {
        it('Then entries is empty array', () => {
          // Arrange
          const content = new Uint8Array(0);

          // Act
          const result = parseTreeContent(DUMMY_ID, content, SHA1_CONFIG);

          // Assert
          expect(result.entries).toEqual([]);
        });
      });
    });

    describe('Given a NUL byte inside the mode region (before the space)', () => {
      describe('When parsing', () => {
        it('Then the mode scan runs first and reports malformed mode, not a name error', () => {
          // Under the parse-tier split, the mode span is scanned for
          // non-octal bytes before the name is ever searched — a NUL byte
          // inside the mode region is refused as a malformed mode, never
          // mistaken for a name terminator.
          // Arrange — content = [0x00] mode + space + 'foo' + NUL + 20-byte hash.
          const sha = new Uint8Array(20).fill(0xab);
          const content = concatBytes(
            new Uint8Array([0x00]),
            new Uint8Array([0x20]),
            encode('foo'),
            new Uint8Array([0x00]),
            sha,
          );

          // Act
          let caught: unknown;
          try {
            parseTreeContent(DUMMY_ID, content, SHA1_CONFIG);
            expect.unreachable();
          } catch (error) {
            caught = error;
          }

          // Assert
          expect((caught as { data: { code: string; reason: string } }).data.code).toBe(
            'INVALID_TREE_ENTRY',
          );
          expect((caught as { data: { reason: string } }).data.reason).toBe('malformed mode');
        });
      });
    });
  });

  describe('serializeTreeContent', () => {
    describe('Given tree with entries', () => {
      describe('When serializing with SHA1_CONFIG', () => {
        it('Then produces byte-identical binary', () => {
          // Arrange
          const sha = new Uint8Array(20).fill(0xab);
          const content = buildTreeEntry('100644', 'hello.txt', sha);
          const tree = parseTreeContent(DUMMY_ID, content, SHA1_CONFIG);

          // Act
          const result = serializeTreeContent(tree, SHA1_CONFIG);

          // Assert
          expect(result).toEqual(content);
        });
      });
    });

    describe('Given unsorted entries', () => {
      describe('When serializing', () => {
        it('Then entries are written in sorted order', () => {
          // Arrange
          const id1 = ObjectId.from('1'.repeat(40));
          const id2 = ObjectId.from('2'.repeat(40));
          const tree = {
            type: 'tree' as const,
            id: DUMMY_ID,
            entries: [
              treeEntry('100644' as const, 'z.txt', id1),
              treeEntry('100644' as const, 'a.txt', id2),
            ],
          };

          // Act
          const result = parseTreeContent(
            DUMMY_ID,
            serializeTreeContent(tree, SHA1_CONFIG),
            SHA1_CONFIG,
          );

          // Assert
          expect(result.entries[0]!.name).toBe('a.txt');
          expect(result.entries[1]!.name).toBe('z.txt');
        });
      });
    });
  });

  describe('roundtrip', () => {
    describe('Given tree with sorted entries from a real git tree', () => {
      describe('When roundtripping parse(serialize(tree))', () => {
        it('Then output bytes are identical to input bytes', () => {
          // Arrange
          const sha1 = new Uint8Array(20).fill(0x01);
          const sha2 = new Uint8Array(20).fill(0x02);
          const content = concatBytes(
            buildTreeEntry('100644', 'a.txt', sha1),
            buildTreeEntry('40000', 'subdir', sha2),
          );
          const tree = parseTreeContent(DUMMY_ID, content, SHA1_CONFIG);

          // Act
          const result = serializeTreeContent(tree, SHA1_CONFIG);

          // Assert
          expect(result).toEqual(content);
        });
      });
    });
  });

  describe('Given a tree entry name carrying a byte-order mark', () => {
    describe('When roundtripping parse(serialize(tree))', () => {
      it('Then output bytes are identical to input bytes — the BOM survives', () => {
        // Arrange
        const sha = new Uint8Array(20).fill(0x09);
        const content = buildTreeEntry('100644', Uint8Array.of(0xef, 0xbb, 0xbf, 0x61), sha);
        const tree = parseTreeContent(DUMMY_ID, content, SHA1_CONFIG);

        // Act
        const result = serializeTreeContent(tree, SHA1_CONFIG);

        // Assert
        expect(result).toEqual(content);
      });
    });
  });

  describe('treeEntryCompare / sortTreeEntries', () => {
    describe('Given entries to sort', () => {
      describe('When sorting', () => {
        it.each([
          {
            entries: [
              treeEntry('100644' as const, 'foo.c', DUMMY_ID),
              treeEntry('100644' as const, 'foo', DUMMY_ID),
            ],
            expected: ['foo', 'foo.c'],
            label: "'foo' (file) comes before 'foo.c' (file)",
          },
          {
            entries: [
              treeEntry('40000' as const, 'foo', DUMMY_ID),
              treeEntry('100644' as const, 'foo.c', DUMMY_ID),
            ],
            expected: ['foo.c', 'foo'],
            label: "'foo.c' (file) comes before 'foo' (dir gets virtual '/')",
          },
          {
            entries: [
              treeEntry('40000' as const, 'foo', DUMMY_ID),
              treeEntry('100644' as const, 'foo-bar', DUMMY_ID),
            ],
            expected: ['foo-bar', 'foo'],
            label: "'foo-bar' (file) comes before 'foo' (dir)",
          },
          {
            entries: [
              treeEntry('40000' as const, 'lib', DUMMY_ID),
              treeEntry('40000' as const, 'doc', DUMMY_ID),
              treeEntry('40000' as const, 'bin', DUMMY_ID),
            ],
            expected: ['bin', 'doc', 'lib'],
            label: 'multiple directories sort by byte-level comparison with trailing "/"',
          },
        ])('Then $label', ({ entries, expected }) => {
          // Arrange & Act
          const result = sortTreeEntries(entries);

          // Assert
          expect(result.map((e) => e.name)).toEqual(expected);
        });
      });
    });

    describe('Given two file entries with different names', () => {
      describe('When comparing with treeEntryCompare', () => {
        it('Then returns negative for alphabetically first', () => {
          // Arrange
          const a: TreeEntry = treeEntry('100644', 'abc', DUMMY_ID);
          const b: TreeEntry = treeEntry('100644', 'xyz', DUMMY_ID);

          // Act
          const result = treeEntryCompare(a, b);

          // Assert
          expect(result).toBeLessThan(0);
        });
      });
      describe('When comparing in reverse', () => {
        it('Then returns positive', () => {
          // Arrange
          const a: TreeEntry = treeEntry('100644', 'xyz', DUMMY_ID);
          const b: TreeEntry = treeEntry('100644', 'abc', DUMMY_ID);

          // Act
          const result = treeEntryCompare(a, b);

          // Assert
          expect(result).toBeGreaterThan(0);
        });
      });
    });

    describe('Given two entries with same name', () => {
      describe('When comparing with treeEntryCompare', () => {
        it('Then returns 0', () => {
          // Arrange
          const a: TreeEntry = treeEntry('100644', 'same', DUMMY_ID);
          const b: TreeEntry = treeEntry('100644', 'same', DUMMY_ID);

          // Act
          const result = treeEntryCompare(a, b);

          // Assert
          expect(result).toBe(0);
        });
      });
    });

    describe('Given a directory and a file with same name prefix', () => {
      describe('When comparing', () => {
        it('Then directory sorts after due to trailing slash', () => {
          // Arrange
          const dir: TreeEntry = treeEntry('40000', 'abc', DUMMY_ID);
          const file: TreeEntry = treeEntry('100644', 'abc', DUMMY_ID);

          // Act
          const result = treeEntryCompare(dir, file);

          // Assert
          expect(result).toBeGreaterThan(0);
        });
      });
    });
  });
});
