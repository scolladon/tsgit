import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { GitIndex, IndexEntry } from '../../../../src/domain/git-index/index-entry.js';
import { parseIndex } from '../../../../src/domain/git-index/index-parser.js';
import { serializeIndex } from '../../../../src/domain/git-index/index-writer.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import { FILE_MODE, FilePath } from '../../../../src/domain/objects/index.js';
import { arbIndexEntry } from './arbitraries.js';

const SHA_A = 'a'.repeat(40) as ObjectId;
const CHECKSUM = new Uint8Array(20);

function withChecksum(data: Uint8Array): Uint8Array {
  const result = new Uint8Array(data.length + CHECKSUM.length);
  result.set(data, 0);
  result.set(CHECKSUM, data.length);
  return result;
}

function makeEntry(path: string, sha: ObjectId = SHA_A) {
  return {
    ctimeSeconds: 1000,
    ctimeNanoseconds: 500,
    mtimeSeconds: 2000,
    mtimeNanoseconds: 600,
    dev: 10,
    ino: 20,
    mode: FILE_MODE.REGULAR,
    uid: 100,
    gid: 200,
    fileSize: 4096,
    id: sha,
    flags: { assumeValid: false, extended: false as const, stage: 0 as const },
    path: FilePath.from(path),
  };
}

describe('serializeIndex', () => {
  it('Given 0 entries, When serializing, Then output is 12-byte header only', () => {
    // Arrange
    const index: GitIndex = { version: 2, entries: [], extensions: [] };

    // Act
    const sut = serializeIndex(index);

    // Assert
    expect(sut.length).toBe(12);
    const view = new DataView(sut.buffer, sut.byteOffset, sut.byteLength);
    expect(view.getUint32(0)).toBe(0x44495243);
    expect(view.getUint32(4)).toBe(2);
    expect(view.getUint32(8)).toBe(0);
  });

  it('Given 1 entry, When serializing then parsing, Then roundtrips', () => {
    // Arrange
    const entry = makeEntry('hello.txt');
    const index: GitIndex = { version: 2, entries: [entry], extensions: [] };

    // Act
    const serialized = serializeIndex(index);
    const sut = parseIndex(withChecksum(serialized));

    // Assert
    expect(sut.entries).toHaveLength(1);
    expect(sut.entries[0]?.path).toBe('hello.txt');
    expect(sut.entries[0]?.id).toBe(SHA_A);
    expect(sut.entries[0]?.mode).toBe(FILE_MODE.REGULAR);
  });

  it('Given 3 entries, When serializing, Then entries are in path-sorted order', () => {
    // Arrange
    const index: GitIndex = {
      version: 2,
      entries: [makeEntry('c.txt'), makeEntry('a.txt'), makeEntry('b.txt')],
      extensions: [],
    };

    // Act
    const serialized = serializeIndex(index);
    const sut = parseIndex(withChecksum(serialized));

    // Assert
    expect(sut.entries[0]?.path).toBe('a.txt');
    expect(sut.entries[1]?.path).toBe('b.txt');
    expect(sut.entries[2]?.path).toBe('c.txt');
  });

  it("Given entry with path 'a/b/c.txt', When serializing, Then padding aligns to 8-byte boundary", () => {
    // Arrange
    const index: GitIndex = {
      version: 2,
      entries: [makeEntry('a/b/c.txt')],
      extensions: [],
    };

    // Act
    const sut = serializeIndex(index);

    // Assert
    const entrySize = sut.length - 12;
    expect(entrySize % 8).toBe(0);
  });

  it('Given entry with path exactly filling 8-byte boundary, When serializing, Then 8 bytes of NUL padding added', () => {
    // Arrange — 62 + pathLen must be divisible by 8, then we get 8 NUL bytes
    // 62 + 2 = 64, which is 8-aligned. With formula (64+8)&~7 = 72, padding = 8.
    const index: GitIndex = {
      version: 2,
      entries: [makeEntry('ab')],
      extensions: [],
    };

    // Act
    const sut = serializeIndex(index);

    // Assert
    const entrySize = sut.length - 12;
    expect(entrySize).toBe(72);
    expect(entrySize % 8).toBe(0);
  });

  it('Given entry with path >= 4095 bytes, When serializing, Then nameLength field set to 0xFFF', () => {
    // Arrange
    const longPath = 'x'.repeat(5000);
    const index: GitIndex = {
      version: 2,
      entries: [makeEntry(longPath)],
      extensions: [],
    };

    // Act
    const sut = serializeIndex(index);
    const view = new DataView(sut.buffer, sut.byteOffset, sut.byteLength);

    // Assert
    const flagsRaw = view.getUint16(12 + 60);
    expect(flagsRaw & 0xfff).toBe(0xfff);
  });

  it('Given index with extensions, When serializing then parsing, Then extensions roundtrip', () => {
    // Arrange
    const extData = new Uint8Array([10, 20, 30]);
    const index: GitIndex = {
      version: 2,
      entries: [],
      extensions: [{ signature: 'TREE', data: extData }],
    };

    // Act
    const serialized = serializeIndex(index);
    const sut = parseIndex(withChecksum(serialized));

    // Assert
    expect(sut.extensions).toHaveLength(1);
    expect(sut.extensions[0]?.signature).toBe('TREE');
    expect(sut.extensions[0]?.data).toEqual(extData);
  });

  it('Given index with two extensions, When serializing then parsing, Then both extensions roundtrip', () => {
    // Arrange — kills offset -= totalLength mutant in extension serialization
    const ext1 = new Uint8Array([10, 20]);
    const ext2 = new Uint8Array([30, 40, 50]);
    const index: GitIndex = {
      version: 2,
      entries: [],
      extensions: [
        { signature: 'TREE', data: ext1 },
        { signature: 'REUC', data: ext2 },
      ],
    };

    // Act
    const serialized = serializeIndex(index);
    const sut = parseIndex(withChecksum(serialized));

    // Assert
    expect(sut.extensions).toHaveLength(2);
    expect(sut.extensions[0]?.signature).toBe('TREE');
    expect(sut.extensions[0]?.data).toEqual(ext1);
    expect(sut.extensions[1]?.signature).toBe('REUC');
    expect(sut.extensions[1]?.data).toEqual(ext2);
  });

  it('Given entries with identical paths, When serializing, Then sort handles equal paths', () => {
    // Arrange
    const index: GitIndex = {
      version: 2,
      entries: [makeEntry('same.txt', SHA_A), makeEntry('same.txt', SHA_A)],
      extensions: [],
    };

    // Act
    const serialized = serializeIndex(index);
    const sut = parseIndex(withChecksum(serialized));

    // Assert
    expect(sut.entries).toHaveLength(2);
    expect(sut.entries[0]?.path).toBe('same.txt');
    expect(sut.entries[1]?.path).toBe('same.txt');
  });

  it('Given 1 entry, When serializing, Then output does NOT include trailing checksum', () => {
    // Arrange
    const index: GitIndex = {
      version: 2,
      entries: [makeEntry('file.txt')],
      extensions: [],
    };

    // Act
    const sut = serializeIndex(index);

    // Assert — output = header (12) + padded entry only, no trailing 20-byte checksum
    const pathBytes = new TextEncoder().encode('file.txt');
    const entryLength = 62 + pathBytes.length;
    const paddedEntryLength = (entryLength + 8) & ~7;
    expect(sut.length).toBe(12 + paddedEntryLength);
  });

  describe('property-based tests', () => {
    it('Given arbitrary entries, When serializing then parsing, Then all entries preserved', () => {
      fc.assert(
        fc.property(fc.array(arbIndexEntry(), { minLength: 0, maxLength: 5 }), (entries) => {
          const uniqueEntries = deduplicateByPath(entries);
          const index: GitIndex = { version: 2, entries: uniqueEntries, extensions: [] };
          const serialized = serializeIndex(index);
          const parsed = parseIndex(withChecksum(serialized));

          const sortedPaths = [...uniqueEntries].map((e) => e.path as string).sort();
          const parsedPaths = parsed.entries.map((e) => e.path as string);
          expect(parsedPaths).toEqual(sortedPaths);
        }),
      );
    });

    it('Given any entry, When serializing, Then total entry size is multiple of 8', () => {
      fc.assert(
        fc.property(arbIndexEntry(), (entry) => {
          const index: GitIndex = { version: 2, entries: [entry], extensions: [] };
          const serialized = serializeIndex(index);
          const entrySize = serialized.length - 12;
          expect(entrySize % 8).toBe(0);
        }),
      );
    });
  });
});

function deduplicateByPath(entries: ReadonlyArray<IndexEntry>): ReadonlyArray<IndexEntry> {
  const seen = new Set<string>();
  return entries.filter((e) => {
    const p = e.path as string;
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });
}
