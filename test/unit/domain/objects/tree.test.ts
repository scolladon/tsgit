import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { encode } from '../../../../src/domain/objects/encoding.js';
import { SHA1_CONFIG, SHA256_CONFIG } from '../../../../src/domain/objects/hash-config.js';
import { ObjectId } from '../../../../src/domain/objects/object-id.js';
import type { TreeEntry } from '../../../../src/domain/objects/tree.js';
import {
  parseTreeContent,
  serializeTreeContent,
  sortTreeEntries,
  treeEntryCompare,
} from '../../../../src/domain/objects/tree.js';
import { arbObjectId } from './arbitraries.js';

const DUMMY_ID = ObjectId.from('a'.repeat(40));

function buildTreeEntry(mode: string, name: string, sha: Uint8Array): Uint8Array {
  const modeBytes = encode(mode);
  const nameBytes = encode(name);
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
  describe('parseTreeContent', () => {
    describe("Given a single entry '100644 hello.txt\\\\0<20-byte-sha>'", () => {
      describe('When parsing with SHA1_CONFIG', () => {
        it("Then mode='100644', name='hello.txt', id=hex of sha", () => {
          // Arrange
          const sha = new Uint8Array(20).fill(0xab);
          const content = buildTreeEntry('100644', 'hello.txt', sha);

          // Act
          const sut = parseTreeContent(DUMMY_ID, content, SHA1_CONFIG);

          // Assert
          expect(sut.entries).toHaveLength(1);
          expect(sut.entries[0]!.mode).toBe('100644');
          expect(sut.entries[0]!.name).toBe('hello.txt');
          expect(sut.entries[0]!.id).toBe('ab'.repeat(20));
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
          const sut = parseTreeContent(DUMMY_ID, content, SHA1_CONFIG);

          // Assert
          expect(sut.entries).toHaveLength(2);
          expect(sut.entries[0]!.name).toBe('a.txt');
          expect(sut.entries[1]!.name).toBe('b.sh');
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
          const sut = parseTreeContent(DUMMY_ID, content, SHA1_CONFIG);

          // Assert
          expect(sut.entries[0]!.mode).toBe('40000');
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
          const sut = parseTreeContent(DUMMY_ID, content, SHA1_CONFIG);

          // Assert
          expect(sut.entries[0]!.name).toBe(name);
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
          const sut = parseTreeContent(DUMMY_ID, content, SHA256_CONFIG);

          // Assert
          expect(sut.entries[0]!.id.length).toBe(64);
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
            buildContent: () => new Uint8Array([49, 48, 48, 54, 52, 52]), // "100644" without space
          },
          {
            label: 'content truncated mid-hash',
            reason: 'truncated hash',
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
            buildContent: () => encode('100644 filename'),
          },
          {
            label: 'an empty entry name',
            reason: 'invalid entry name: ',
            buildContent: () => buildTreeEntry('100644', '', new Uint8Array(20).fill(0xab)),
          },
          {
            label: "an entry name of '.'",
            reason: 'invalid entry name: .',
            buildContent: () => buildTreeEntry('100644', '.', new Uint8Array(20).fill(0xab)),
          },
          {
            label: "an entry name of '..'",
            reason: 'invalid entry name: ..',
            buildContent: () => buildTreeEntry('100644', '..', new Uint8Array(20).fill(0xab)),
          },
          {
            label: "an entry name containing '/'",
            reason: 'invalid entry name: sub/dir',
            buildContent: () => buildTreeEntry('100644', 'sub/dir', new Uint8Array(20).fill(0xab)),
          },
          {
            label: 'duplicate entry names',
            reason: 'duplicate entry name: same.txt',
            buildContent: () =>
              concatBytes(
                buildTreeEntry('100644', 'same.txt', new Uint8Array(20).fill(0x01)),
                buildTreeEntry('100644', 'same.txt', new Uint8Array(20).fill(0x02)),
              ),
          },
        ])('Then throws INVALID_TREE_ENTRY for $label', ({ buildContent, reason }) => {
          // Arrange
          const content = buildContent();

          // Act + Assert
          expect(() => parseTreeContent(DUMMY_ID, content, SHA1_CONFIG)).toThrow(
            expect.objectContaining({
              data: expect.objectContaining({
                code: 'INVALID_TREE_ENTRY',
                reason,
              }),
            }),
          );
        });
      });
    });

    describe('Given empty content (0 bytes)', () => {
      describe('When parsing', () => {
        it('Then entries is empty array', () => {
          // Arrange
          const content = new Uint8Array(0);

          // Act
          const sut = parseTreeContent(DUMMY_ID, content, SHA1_CONFIG);

          // Assert
          expect(sut.entries).toEqual([]);
        });
      });
    });

    describe('Given a NUL byte inside the mode region (before the space)', () => {
      describe('When parsing', () => {
        it('Then the NUL search starts AFTER the space and the failure is INVALID_FILE_MODE, not a name error', () => {
          // The NUL search begins at `spaceIndex + 1`. A mutant starting it at
          // `spaceIndex - 1` would find the NUL byte that lives in the mode region
          // (index 0 here), cut the name to empty, and throw INVALID_TREE_ENTRY.
          // The correct offset skips that NUL and reaches mode validation, which
          // rejects the ' ' mode with INVALID_FILE_MODE.
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

          // Assert — proves the NUL search skipped the in-mode NUL: a name error
          // would mean the search started too early.
          expect((caught as { data: { code: string; value: string } }).data.code).toBe(
            'INVALID_FILE_MODE',
          );
          expect((caught as { data: { value: string } }).data.value).toBe(' ');
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
          const sut = serializeTreeContent(tree, SHA1_CONFIG);

          // Assert
          expect(sut).toEqual(content);
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
              { mode: '100644' as const, name: 'z.txt', id: id1 },
              { mode: '100644' as const, name: 'a.txt', id: id2 },
            ],
          };

          // Act
          const sut = parseTreeContent(
            DUMMY_ID,
            serializeTreeContent(tree, SHA1_CONFIG),
            SHA1_CONFIG,
          );

          // Assert
          expect(sut.entries[0]!.name).toBe('a.txt');
          expect(sut.entries[1]!.name).toBe('z.txt');
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
          const sut = serializeTreeContent(tree, SHA1_CONFIG);

          // Assert
          expect(sut).toEqual(content);
        });
      });
    });
  });

  describe('treeEntryCompare / sortTreeEntries', () => {
    describe('Given entries to sort', () => {
      describe('When sorting', () => {
        it.each([
          {
            entries: [
              { mode: '100644' as const, name: 'foo.c', id: DUMMY_ID },
              { mode: '100644' as const, name: 'foo', id: DUMMY_ID },
            ],
            expected: ['foo', 'foo.c'],
            label: "'foo' (file) comes before 'foo.c' (file)",
          },
          {
            entries: [
              { mode: '40000' as const, name: 'foo', id: DUMMY_ID },
              { mode: '100644' as const, name: 'foo.c', id: DUMMY_ID },
            ],
            expected: ['foo.c', 'foo'],
            label: "'foo.c' (file) comes before 'foo' (dir gets virtual '/')",
          },
          {
            entries: [
              { mode: '40000' as const, name: 'foo', id: DUMMY_ID },
              { mode: '100644' as const, name: 'foo-bar', id: DUMMY_ID },
            ],
            expected: ['foo-bar', 'foo'],
            label: "'foo-bar' (file) comes before 'foo' (dir)",
          },
          {
            entries: [
              { mode: '40000' as const, name: 'lib', id: DUMMY_ID },
              { mode: '40000' as const, name: 'doc', id: DUMMY_ID },
              { mode: '40000' as const, name: 'bin', id: DUMMY_ID },
            ],
            expected: ['bin', 'doc', 'lib'],
            label: 'multiple directories sort by byte-level comparison with trailing "/"',
          },
        ])('Then $label', ({ entries, expected }) => {
          // Act
          const sut = sortTreeEntries(entries);

          // Assert
          expect(sut.map((e) => e.name)).toEqual(expected);
        });
      });
    });

    describe('Given two file entries with different names', () => {
      describe('When comparing with treeEntryCompare', () => {
        it('Then returns negative for alphabetically first', () => {
          // Arrange
          const a: TreeEntry = { mode: '100644', name: 'abc', id: DUMMY_ID };
          const b: TreeEntry = { mode: '100644', name: 'xyz', id: DUMMY_ID };

          // Act
          const sut = treeEntryCompare(a, b);

          // Assert
          expect(sut).toBeLessThan(0);
        });
      });
      describe('When comparing in reverse', () => {
        it('Then returns positive', () => {
          // Arrange
          const a: TreeEntry = { mode: '100644', name: 'xyz', id: DUMMY_ID };
          const b: TreeEntry = { mode: '100644', name: 'abc', id: DUMMY_ID };

          // Act
          const sut = treeEntryCompare(a, b);

          // Assert
          expect(sut).toBeGreaterThan(0);
        });
      });
    });

    describe('Given two entries with same name', () => {
      describe('When comparing with treeEntryCompare', () => {
        it('Then returns 0', () => {
          // Arrange
          const a: TreeEntry = { mode: '100644', name: 'same', id: DUMMY_ID };
          const b: TreeEntry = { mode: '100644', name: 'same', id: DUMMY_ID };

          // Act
          const sut = treeEntryCompare(a, b);

          // Assert
          expect(sut).toBe(0);
        });
      });
    });

    describe('Given a directory and a file with same name prefix', () => {
      describe('When comparing', () => {
        it('Then directory sorts after due to trailing slash', () => {
          // Arrange
          const dir: TreeEntry = { mode: '40000', name: 'abc', id: DUMMY_ID };
          const file: TreeEntry = { mode: '100644', name: 'abc', id: DUMMY_ID };

          // Act
          const sut = treeEntryCompare(dir, file);

          // Assert
          expect(sut).toBeGreaterThan(0);
        });
      });
    });
  });

  describe('property-based tests', () => {
    const arbTreeEntry: fc.Arbitrary<TreeEntry> = fc
      .tuple(
        fc.constantFrom(
          '100644' as const,
          '100755' as const,
          '120000' as const,
          '40000' as const,
          '160000' as const,
        ),
        fc
          .string({ minLength: 1, maxLength: 50 })
          .filter((s) => !s.includes('\0') && !s.includes('/') && s !== '.' && s !== '..'),
        arbObjectId(40),
      )
      .map(([mode, name, id]) => ({ mode, name, id }));

    describe('Given the sort idempotence property "sort(sort(entries)) equals sort(entries)"', () => {
      describe('When checked', () => {
        it('Then it holds', () => {
          // Arrange + Assert
          fc.assert(
            fc.property(fc.array(arbTreeEntry), (entries) => {
              const sorted = sortTreeEntries(entries);
              const resorted = sortTreeEntries([...sorted]);
              expect(resorted).toEqual(sorted);
            }),
          );
        });
      });
    });

    describe('Given the sort byte-consistency property "for adjacent sorted entries, treeEntryCompare(a, b) <= 0"', () => {
      describe('When checked', () => {
        it('Then it holds', () => {
          // Arrange + Assert
          fc.assert(
            fc.property(fc.array(arbTreeEntry, { minLength: 2 }), (entries) => {
              const sorted = sortTreeEntries(entries);
              for (let i = 1; i < sorted.length; i++) {
                expect(treeEntryCompare(sorted[i - 1]!, sorted[i]!)).toBeLessThanOrEqual(0);
              }
            }),
          );
        });
      });
    });

    describe('Given the tree roundtrip property "parseTreeContent(id, serializeTreeContent(tree, hash), hash) preserves all entries"', () => {
      describe('When checked', () => {
        it('Then it holds', () => {
          // Arrange + Assert
          // Git trees cannot contain duplicate entry names — the parser rejects them.
          // Dedupe by name before building the tree so the arbitrary never generates
          // a tree that is invalid by construction (which would look like a flaky test).
          fc.assert(
            fc.property(fc.array(arbTreeEntry), (rawEntries) => {
              const seen = new Set<string>();
              const entries = rawEntries.filter((e) => {
                if (seen.has(e.name)) return false;
                seen.add(e.name);
                return true;
              });
              const tree = {
                type: 'tree' as const,
                id: DUMMY_ID,
                entries,
              };
              const serialized = serializeTreeContent(tree, SHA1_CONFIG);
              const sut = parseTreeContent(DUMMY_ID, serialized, SHA1_CONFIG);
              const sorted = sortTreeEntries(entries);
              expect(sut.entries).toEqual(sorted);
            }),
          );
        });
      });
    });
  });
});
