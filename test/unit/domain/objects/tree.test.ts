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
    it("Given a single entry '100644 hello.txt\\0<20-byte-sha>', When parsing with SHA1_CONFIG, Then mode='100644', name='hello.txt', id=hex of sha", () => {
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

    it('Given multiple entries concatenated, When parsing, Then returns all entries in order', () => {
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

    it("Given directory mode '40000' in bytes, When parsing, Then mode is '40000' (not '040000')", () => {
      // Arrange
      const sha = new Uint8Array(20).fill(0xcc);
      const content = buildTreeEntry('40000', 'subdir', sha);

      // Act
      const sut = parseTreeContent(DUMMY_ID, content, SHA1_CONFIG);

      // Assert
      expect(sut.entries[0]!.mode).toBe('40000');
    });

    it('Given entry with non-ASCII UTF-8 name, When parsing, Then name is correctly decoded', () => {
      // Arrange
      const sha = new Uint8Array(20).fill(0xdd);
      const content = buildTreeEntry('100644', '日本語.txt', sha);

      // Act
      const sut = parseTreeContent(DUMMY_ID, content, SHA1_CONFIG);

      // Assert
      expect(sut.entries[0]!.name).toBe('日本語.txt');
    });

    it('Given entry with name containing a space, When parsing, Then name includes the space', () => {
      // Arrange
      const sha = new Uint8Array(20).fill(0xee);
      const content = buildTreeEntry('100644', 'my file.txt', sha);

      // Act
      const sut = parseTreeContent(DUMMY_ID, content, SHA1_CONFIG);

      // Assert
      expect(sut.entries[0]!.name).toBe('my file.txt');
    });

    it('Given SHA-256 tree (32-byte hashes), When parsing with SHA256_CONFIG, Then ObjectIds are 64-char hex', () => {
      // Arrange
      const sha = new Uint8Array(32).fill(0xff);
      const content = buildTreeEntry('100644', 'file.txt', sha);

      // Act
      const sut = parseTreeContent(DUMMY_ID, content, SHA256_CONFIG);

      // Assert
      expect(sut.entries[0]!.id.length).toBe(64);
    });

    it('Given entry with single-char name, When parsing, Then name is correctly extracted', () => {
      // Arrange — mode + space + 'x' + null + hash; ensures null search starts after space
      const sha = new Uint8Array(20).fill(0x01);
      const content = buildTreeEntry('100644', 'x', sha);

      // Act
      const sut = parseTreeContent(DUMMY_ID, content, SHA1_CONFIG);

      // Assert
      expect(sut.entries[0]!.name).toBe('x');
    });

    it('Given content with no space after mode, When parsing, Then throws INVALID_TREE_ENTRY with missing space reason', () => {
      // Arrange - a byte array with no space byte (0x20) at all
      const content = new Uint8Array([49, 48, 48, 54, 52, 52]); // "100644" without space

      // Act + Assert
      expect(() => parseTreeContent(DUMMY_ID, content, SHA1_CONFIG)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_TREE_ENTRY',
            reason: 'missing space after mode',
          }),
        }),
      );
    });

    it('Given truncated content (cuts off mid-hash), When parsing, Then throws INVALID_TREE_ENTRY with truncated hash reason', () => {
      // Arrange
      const content = concatBytes(
        encode('100644'),
        new Uint8Array([0x20]),
        encode('file'),
        new Uint8Array([0x00]),
        new Uint8Array(10), // only 10 bytes, need 20
      );

      // Act + Assert
      expect(() => parseTreeContent(DUMMY_ID, content, SHA1_CONFIG)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_TREE_ENTRY',
            reason: 'truncated hash',
          }),
        }),
      );
    });

    it('Given truncated content (no null after name), When parsing, Then throws INVALID_TREE_ENTRY with missing null reason', () => {
      // Arrange
      const content = encode('100644 filename');

      // Act + Assert
      expect(() => parseTreeContent(DUMMY_ID, content, SHA1_CONFIG)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_TREE_ENTRY',
            reason: 'missing null after name',
          }),
        }),
      );
    });

    it('Given entry with empty name, When parsing, Then throws INVALID_TREE_ENTRY with invalid entry name reason', () => {
      // Arrange
      const sha = new Uint8Array(20).fill(0xab);
      const content = buildTreeEntry('100644', '', sha);

      // Act + Assert
      expect(() => parseTreeContent(DUMMY_ID, content, SHA1_CONFIG)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_TREE_ENTRY',
            reason: 'invalid entry name: ',
          }),
        }),
      );
    });

    it("Given entry with name '.', When parsing, Then throws INVALID_TREE_ENTRY with invalid entry name reason", () => {
      // Arrange
      const sha = new Uint8Array(20).fill(0xab);
      const content = buildTreeEntry('100644', '.', sha);

      // Act + Assert
      expect(() => parseTreeContent(DUMMY_ID, content, SHA1_CONFIG)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_TREE_ENTRY',
            reason: 'invalid entry name: .',
          }),
        }),
      );
    });

    it("Given entry with name '..', When parsing, Then throws INVALID_TREE_ENTRY with invalid entry name reason", () => {
      // Arrange
      const sha = new Uint8Array(20).fill(0xab);
      const content = buildTreeEntry('100644', '..', sha);

      // Act + Assert
      expect(() => parseTreeContent(DUMMY_ID, content, SHA1_CONFIG)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_TREE_ENTRY',
            reason: 'invalid entry name: ..',
          }),
        }),
      );
    });

    it("Given entry with name containing '/', When parsing, Then throws INVALID_TREE_ENTRY with invalid entry name reason", () => {
      // Arrange
      const sha = new Uint8Array(20).fill(0xab);
      const content = buildTreeEntry('100644', 'sub/dir', sha);

      // Act + Assert
      expect(() => parseTreeContent(DUMMY_ID, content, SHA1_CONFIG)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_TREE_ENTRY',
            reason: 'invalid entry name: sub/dir',
          }),
        }),
      );
    });

    it('Given tree with duplicate entry names, When parsing, Then throws INVALID_TREE_ENTRY with duplicate name reason', () => {
      // Arrange
      const sha1 = new Uint8Array(20).fill(0x01);
      const sha2 = new Uint8Array(20).fill(0x02);
      const content = concatBytes(
        buildTreeEntry('100644', 'same.txt', sha1),
        buildTreeEntry('100644', 'same.txt', sha2),
      );

      // Act + Assert
      expect(() => parseTreeContent(DUMMY_ID, content, SHA1_CONFIG)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_TREE_ENTRY',
            reason: 'duplicate entry name: same.txt',
          }),
        }),
      );
    });

    it('Given empty content (0 bytes), When parsing, Then entries is empty array', () => {
      // Arrange
      const content = new Uint8Array(0);

      // Act
      const sut = parseTreeContent(DUMMY_ID, content, SHA1_CONFIG);

      // Assert
      expect(sut.entries).toEqual([]);
    });

    it('Given a NUL byte inside the mode region (before the space), When parsing, Then the NUL search starts AFTER the space and the failure is INVALID_FILE_MODE, not a name error', () => {
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

  describe('serializeTreeContent', () => {
    it('Given tree with entries, When serializing with SHA1_CONFIG, Then produces byte-identical binary', () => {
      // Arrange
      const sha = new Uint8Array(20).fill(0xab);
      const content = buildTreeEntry('100644', 'hello.txt', sha);
      const tree = parseTreeContent(DUMMY_ID, content, SHA1_CONFIG);

      // Act
      const sut = serializeTreeContent(tree, SHA1_CONFIG);

      // Assert
      expect(sut).toEqual(content);
    });

    it('Given unsorted entries, When serializing, Then entries are written in sorted order', () => {
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
      const sut = parseTreeContent(DUMMY_ID, serializeTreeContent(tree, SHA1_CONFIG), SHA1_CONFIG);

      // Assert
      expect(sut.entries[0]!.name).toBe('a.txt');
      expect(sut.entries[1]!.name).toBe('z.txt');
    });
  });

  describe('roundtrip', () => {
    it('Given tree with sorted entries from a real git tree, When roundtripping parse(serialize(tree)), Then output bytes are identical to input bytes', () => {
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

  describe('treeEntryCompare / sortTreeEntries', () => {
    it("Given entries 'foo' (file) and 'foo.c' (file), When sorting, Then 'foo' comes before 'foo.c'", () => {
      // Arrange
      const entries: TreeEntry[] = [
        { mode: '100644', name: 'foo.c', id: DUMMY_ID },
        { mode: '100644', name: 'foo', id: DUMMY_ID },
      ];

      // Act
      const sut = sortTreeEntries(entries);

      // Assert
      expect(sut[0]!.name).toBe('foo');
      expect(sut[1]!.name).toBe('foo.c');
    });

    it("Given entries 'foo' (dir) and 'foo.c' (file), When sorting, Then 'foo.c' comes before 'foo' (dir gets virtual '/')", () => {
      // Arrange
      const entries: TreeEntry[] = [
        { mode: '40000', name: 'foo', id: DUMMY_ID },
        { mode: '100644', name: 'foo.c', id: DUMMY_ID },
      ];

      // Act
      const sut = sortTreeEntries(entries);

      // Assert
      expect(sut[0]!.name).toBe('foo.c');
      expect(sut[1]!.name).toBe('foo');
    });

    it("Given entries 'foo' (dir) and 'foo-bar' (file), When sorting, Then 'foo-bar' comes before 'foo' (dir)", () => {
      // Arrange
      const entries: TreeEntry[] = [
        { mode: '40000', name: 'foo', id: DUMMY_ID },
        { mode: '100644', name: 'foo-bar', id: DUMMY_ID },
      ];

      // Act
      const sut = sortTreeEntries(entries);

      // Assert
      expect(sut[0]!.name).toBe('foo-bar');
      expect(sut[1]!.name).toBe('foo');
    });

    it('Given two file entries with different names, When comparing with treeEntryCompare, Then returns negative for alphabetically first', () => {
      // Arrange
      const a: TreeEntry = { mode: '100644', name: 'abc', id: DUMMY_ID };
      const b: TreeEntry = { mode: '100644', name: 'xyz', id: DUMMY_ID };

      // Act
      const sut = treeEntryCompare(a, b);

      // Assert
      expect(sut).toBeLessThan(0);
    });

    it('Given two file entries with different names, When comparing in reverse, Then returns positive', () => {
      // Arrange
      const a: TreeEntry = { mode: '100644', name: 'xyz', id: DUMMY_ID };
      const b: TreeEntry = { mode: '100644', name: 'abc', id: DUMMY_ID };

      // Act
      const sut = treeEntryCompare(a, b);

      // Assert
      expect(sut).toBeGreaterThan(0);
    });

    it('Given two entries with same name, When comparing with treeEntryCompare, Then returns 0', () => {
      // Arrange
      const a: TreeEntry = { mode: '100644', name: 'same', id: DUMMY_ID };
      const b: TreeEntry = { mode: '100644', name: 'same', id: DUMMY_ID };

      // Act
      const sut = treeEntryCompare(a, b);

      // Assert
      expect(sut).toBe(0);
    });

    it('Given a directory and a file with same name prefix, When comparing, Then directory sorts after due to trailing slash', () => {
      // Arrange
      const dir: TreeEntry = { mode: '40000', name: 'abc', id: DUMMY_ID };
      const file: TreeEntry = { mode: '100644', name: 'abc', id: DUMMY_ID };

      // Act
      const sut = treeEntryCompare(dir, file);

      // Assert
      expect(sut).toBeGreaterThan(0);
    });

    it('Given multiple directories, When sorting, Then sorted by byte-level comparison with trailing "/"', () => {
      // Arrange
      const entries: TreeEntry[] = [
        { mode: '40000', name: 'lib', id: DUMMY_ID },
        { mode: '40000', name: 'doc', id: DUMMY_ID },
        { mode: '40000', name: 'bin', id: DUMMY_ID },
      ];

      // Act
      const sut = sortTreeEntries(entries);

      // Assert
      expect(sut.map((e) => e.name)).toEqual(['bin', 'doc', 'lib']);
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

    it('Given the sort idempotence property "sort(sort(entries)) equals sort(entries)", When checked, Then it holds', () => {
      // Arrange
      // Assert
      fc.assert(
        fc.property(fc.array(arbTreeEntry), (entries) => {
          const sorted = sortTreeEntries(entries);
          const resorted = sortTreeEntries([...sorted]);
          expect(resorted).toEqual(sorted);
        }),
      );
    });

    it('Given the sort byte-consistency property "for adjacent sorted entries, treeEntryCompare(a, b) <= 0", When checked, Then it holds', () => {
      // Arrange
      // Assert
      fc.assert(
        fc.property(fc.array(arbTreeEntry, { minLength: 2 }), (entries) => {
          const sorted = sortTreeEntries(entries);
          for (let i = 1; i < sorted.length; i++) {
            expect(treeEntryCompare(sorted[i - 1]!, sorted[i]!)).toBeLessThanOrEqual(0);
          }
        }),
      );
    });

    it('Given the tree roundtrip property "parseTreeContent(id, serializeTreeContent(tree, hash), hash) preserves all entries", When checked, Then it holds', () => {
      // Arrange
      // Git trees cannot contain duplicate entry names — the parser rejects them.
      // Dedupe by name before building the tree so the arbitrary never generates
      // a tree that is invalid by construction (which would look like a flaky test).
      // Assert
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
