import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type {
  GitIndex,
  IndexEntry,
  IndexEntryFlags,
} from '../../../../src/domain/git-index/index-entry.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index-entry.js';
import { parseIndex } from '../../../../src/domain/git-index/index-parser.js';
import { compareEntryPath, serializeIndex } from '../../../../src/domain/git-index/index-writer.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import { bytesToHex, FILE_MODE, FilePath } from '../../../../src/domain/objects/index.js';
import { arbIndexEntry } from './arbitraries.js';

const SHA_A = 'a'.repeat(40) as ObjectId;
const CHECKSUM = new Uint8Array(20);

function withChecksum(data: Uint8Array): Uint8Array {
  const result = new Uint8Array(data.length + CHECKSUM.length);
  result.set(data, 0);
  result.set(CHECKSUM, data.length);
  return result;
}

function makeEntry(
  path: string,
  sha: ObjectId = SHA_A,
  flags: IndexEntryFlags = STAGE0_FLAGS,
): IndexEntry {
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
    flags,
    path: FilePath.from(path),
  };
}

describe('compareEntryPath', () => {
  describe('Given two entries to compare by path', () => {
    describe('When compared', () => {
      it.each([
        {
          // Pins the `< → -1` branch.
          label: 'returns exactly -1 when the first path sorts before the second',
          firstPath: 'a.txt',
          firstSha: SHA_A,
          secondPath: 'b.txt',
          secondSha: SHA_A,
          expected: -1,
        },
        {
          // Kills the `> → <=` mutant and the ConditionalExpression→false
          // mutant (both would return 0).
          label: 'returns exactly +1 when the first path sorts after the second',
          firstPath: 'b.txt',
          firstSha: SHA_A,
          secondPath: 'a.txt',
          secondSha: SHA_A,
          expected: 1,
        },
        {
          // Distinct SHAs prove the comparator looks only at paths. Kills
          // `< → <=` (would return -1), `> → >=` (would return 1) and
          // ConditionalExpression→true (would return 1).
          label: 'returns exactly 0 when the paths are identical (stable order preserved)',
          firstPath: 'same.txt',
          firstSha: 'a'.repeat(40) as ObjectId,
          secondPath: 'same.txt',
          secondSha: 'b'.repeat(40) as ObjectId,
          expected: 0,
        },
      ])('Then $label', ({ firstPath, firstSha, secondPath, secondSha, expected }) => {
        // Arrange
        const first = makeEntry(firstPath, firstSha);
        const second = makeEntry(secondPath, secondSha);

        // Act
        const result = compareEntryPath(first, second);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('serializeIndex', () => {
  describe('Given 0 entries', () => {
    describe('When serializing', () => {
      it('Then output is 12-byte header only', () => {
        // Arrange
        const index: GitIndex = {
          version: 2,
          entries: [],
          extensions: [],
          trailerSha: new Uint8Array(0),
        };

        // Act
        const result = serializeIndex(index, 20);

        // Assert
        expect(result.length).toBe(12);
        const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
        expect(view.getUint32(0)).toBe(0x44495243);
        expect(view.getUint32(4)).toBe(2);
        expect(view.getUint32(8)).toBe(0);
      });
    });
  });

  describe('Given 1 entry', () => {
    describe('When serializing then parsing', () => {
      it('Then roundtrips', () => {
        // Arrange
        const entry = makeEntry('hello.txt');
        const index: GitIndex = {
          version: 2,
          entries: [entry],
          extensions: [],
          trailerSha: new Uint8Array(0),
        };

        // Act
        const serialized = serializeIndex(index, 20);
        const result = parseIndex(withChecksum(serialized), 20);

        // Assert
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]?.path).toBe('hello.txt');
        expect(result.entries[0]?.id).toBe(SHA_A);
        expect(result.entries[0]?.mode).toBe(FILE_MODE.REGULAR);
      });
    });
  });

  describe('Given 3 entries', () => {
    describe('When serializing', () => {
      it('Then entries are in path-sorted order', () => {
        // Arrange
        const index: GitIndex = {
          version: 2,
          entries: [makeEntry('c.txt'), makeEntry('a.txt'), makeEntry('b.txt')],
          extensions: [],
          trailerSha: new Uint8Array(0),
        };

        // Act
        const serialized = serializeIndex(index, 20);
        const result = parseIndex(withChecksum(serialized), 20);

        // Assert
        expect(result.entries[0]?.path).toBe('a.txt');
        expect(result.entries[1]?.path).toBe('b.txt');
        expect(result.entries[2]?.path).toBe('c.txt');
      });
    });
  });

  describe("Given entry with path 'a/b/c.txt'", () => {
    describe('When serializing', () => {
      it('Then padding aligns to 8-byte boundary', () => {
        // Arrange
        const index: GitIndex = {
          version: 2,
          entries: [makeEntry('a/b/c.txt')],
          extensions: [],
          trailerSha: new Uint8Array(0),
        };

        // Act
        const result = serializeIndex(index, 20);

        // Assert
        const entrySize = result.length - 12;
        expect(entrySize % 8).toBe(0);
      });
    });
  });

  describe('Given entry with path exactly filling 8-byte boundary', () => {
    describe('When serializing', () => {
      it('Then 8 bytes of NUL padding added', () => {
        // Arrange — 62 + pathLen must be divisible by 8, then we get 8 NUL bytes
        // 62 + 2 = 64, which is 8-aligned. With formula (64+8)&~7 = 72, padding = 8.
        const index: GitIndex = {
          version: 2,
          entries: [makeEntry('ab')],
          extensions: [],
          trailerSha: new Uint8Array(0),
        };

        // Act
        const result = serializeIndex(index, 20);

        // Assert
        const entrySize = result.length - 12;
        expect(entrySize).toBe(72);
        expect(entrySize % 8).toBe(0);
      });
    });
  });

  describe('Given entry with path >= 4095 bytes', () => {
    describe('When serializing', () => {
      it('Then nameLength field set to 0xFFF', () => {
        // Arrange
        const longPath = 'x'.repeat(5000);
        const index: GitIndex = {
          version: 2,
          entries: [makeEntry(longPath)],
          extensions: [],
          trailerSha: new Uint8Array(0),
        };

        // Act
        const result = serializeIndex(index, 20);
        const view = new DataView(result.buffer, result.byteOffset, result.byteLength);

        // Assert
        const flagsRaw = view.getUint16(12 + 60);
        expect(flagsRaw & 0xfff).toBe(0xfff);
      });
    });
  });

  describe('Given index with extensions', () => {
    describe('When serializing then parsing', () => {
      it('Then extensions roundtrip', () => {
        // Arrange
        const extData = new Uint8Array([10, 20, 30]);
        const index: GitIndex = {
          version: 2,
          entries: [],
          extensions: [{ signature: 'TREE', data: extData }],
          trailerSha: new Uint8Array(0),
        };

        // Act
        const serialized = serializeIndex(index, 20);
        const result = parseIndex(withChecksum(serialized), 20);

        // Assert
        expect(result.extensions).toHaveLength(1);
        expect(result.extensions[0]?.signature).toBe('TREE');
        expect(result.extensions[0]?.data).toEqual(extData);
      });
    });
  });

  describe('Given index with two extensions', () => {
    describe('When serializing then parsing', () => {
      it('Then both extensions roundtrip', () => {
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
          trailerSha: new Uint8Array(0),
        };

        // Act
        const serialized = serializeIndex(index, 20);
        const result = parseIndex(withChecksum(serialized), 20);

        // Assert
        expect(result.extensions).toHaveLength(2);
        expect(result.extensions[0]?.signature).toBe('TREE');
        expect(result.extensions[0]?.data).toEqual(ext1);
        expect(result.extensions[1]?.signature).toBe('REUC');
        expect(result.extensions[1]?.data).toEqual(ext2);
      });
    });
  });

  describe('Given entries with identical paths', () => {
    describe('When serializing', () => {
      it('Then sort handles equal paths', () => {
        // Arrange
        const index: GitIndex = {
          version: 2,
          entries: [makeEntry('same.txt', SHA_A), makeEntry('same.txt', SHA_A)],
          extensions: [],
          trailerSha: new Uint8Array(0),
        };

        // Act
        const serialized = serializeIndex(index, 20);
        const result = parseIndex(withChecksum(serialized), 20);

        // Assert
        expect(result.entries).toHaveLength(2);
        expect(result.entries[0]?.path).toBe('same.txt');
        expect(result.entries[1]?.path).toBe('same.txt');
      });
    });
  });

  describe('Given 1 entry', () => {
    describe('When serializing', () => {
      it('Then output does NOT include trailing checksum', () => {
        // Arrange
        const index: GitIndex = {
          version: 2,
          entries: [makeEntry('file.txt')],
          extensions: [],
          trailerSha: new Uint8Array(0),
        };

        // Act
        const result = serializeIndex(index, 20);

        // Assert — output = header (12) + padded entry only, no trailing 20-byte checksum
        const pathBytes = new TextEncoder().encode('file.txt');
        const entryLength = 62 + pathBytes.length;
        const paddedEntryLength = (entryLength + 8) & ~7;
        expect(result.length).toBe(12 + paddedEntryLength);
      });
    });
  });

  describe('property-based tests', () => {
    describe('Given arbitrary entries', () => {
      describe('When serializing then parsing', () => {
        it('Then all entries preserved', () => {
          // Arrange
          fc.assert(
            fc.property(fc.array(arbIndexEntry(), { minLength: 0, maxLength: 5 }), (entries) => {
              const uniqueEntries = deduplicateByPath(entries);
              const index: GitIndex = {
                version: 2,
                entries: uniqueEntries,
                extensions: [],
                trailerSha: new Uint8Array(0),
              };

              // Act
              const serialized = serializeIndex(index, 20);
              const parsed = parseIndex(withChecksum(serialized), 20);

              // Assert
              const sortedPaths = [...uniqueEntries].map((e) => e.path as string).sort();
              const parsedPaths = parsed.entries.map((e) => e.path as string);
              expect(parsedPaths).toEqual(sortedPaths);
            }),
          );
        });
      });
    });

    describe('Given any entry', () => {
      describe('When serializing', () => {
        it('Then total entry size is multiple of 8', () => {
          // Arrange
          fc.assert(
            fc.property(arbIndexEntry(), (entry) => {
              const index: GitIndex = {
                version: 2,
                entries: [entry],
                extensions: [],
                trailerSha: new Uint8Array(0),
              };

              // Act
              const serialized = serializeIndex(index, 20);
              const entrySize = serialized.length - 12;

              // Assert
              expect(entrySize % 8).toBe(0);
            }),
          );
        });
      });
    });
  });
});

describe('serializeIndex — oid width framing', () => {
  const SHA_256_A = '2cf8d83d9ee29543b34a87727421fdecb7e3f3a183d337639025de576db9ebb4' as ObjectId;

  describe('Given an index entry with a 32-byte oid', () => {
    describe('When serializeIndex frames it at digestLength 32', () => {
      it('Then the flags word sits at offset+72 and the oid bytes at offset+40 survive intact', () => {
        // Arrange
        const index: GitIndex = {
          version: 2,
          entries: [makeEntry('a.txt', SHA_256_A)],
          extensions: [],
          trailerSha: new Uint8Array(0),
        };

        // Act
        const result = serializeIndex(index, 32);
        const view = new DataView(result.buffer, result.byteOffset, result.byteLength);

        // Assert — the 32-byte oid at offset+40 must be intact: the shipped
        // bug wrote the flags word at the SHA-1-width offset+60, which lands
        // inside a 32-byte oid and corrupts its last 12 bytes.
        const oidBytes = result.subarray(12 + 40, 12 + 40 + 32);
        expect(bytesToHex(oidBytes)).toBe(SHA_256_A);
        expect(view.getUint16(12 + 72) & 0xfff).toBe(5);
        const nameBytes = result.subarray(12 + 74, 12 + 74 + 5);
        expect(new TextDecoder().decode(nameBytes)).toBe('a.txt');
      });
    });
  });

  describe('Given a SHA-1 entry', () => {
    describe('When serializeIndex frames it at digestLength 20', () => {
      it("Then the emitted bytes are byte-identical to today's golden", () => {
        // Arrange — golden captured from serializeIndex before the
        // digestLength parameter existed, for a single 'hello.txt' entry.
        const index: GitIndex = {
          version: 2,
          entries: [makeEntry('hello.txt')],
          extensions: [],
          trailerSha: new Uint8Array(0),
        };
        const golden =
          '444952430000000200000001000003e8000001f4000007d0000002580000000a' +
          '00000014000081a400000064000000c800001000aaaaaaaaaaaaaaaaaaaaaaaa' +
          'aaaaaaaaaaaaaaaa000968656c6c6f2e74787400';

        // Act
        const result = serializeIndex(index, 20);

        // Assert
        expect(bytesToHex(result)).toBe(golden);
      });
    });
  });

  describe('Given entries at both digest lengths', () => {
    describe('When the oid is written', () => {
      it('Then it always starts at offset+40', () => {
        // Arrange
        const sha1Index: GitIndex = {
          version: 2,
          entries: [makeEntry('a.txt', SHA_A)],
          extensions: [],
          trailerSha: new Uint8Array(0),
        };
        const sha256Index: GitIndex = {
          version: 2,
          entries: [makeEntry('a.txt', SHA_256_A)],
          extensions: [],
          trailerSha: new Uint8Array(0),
        };

        // Act
        const sha1Result = serializeIndex(sha1Index, 20);
        const sha256Result = serializeIndex(sha256Index, 32);

        // Assert
        expect(bytesToHex(sha1Result.subarray(12 + 40, 12 + 40 + 20))).toBe(SHA_A);
        expect(bytesToHex(sha256Result.subarray(12 + 40, 12 + 40 + 32))).toBe(SHA_256_A);
      });
    });
  });
});

describe('serializeIndex — index v3 extended flags', () => {
  const SKIP_FLAGS: IndexEntryFlags = { ...STAGE0_FLAGS, skipWorktree: true };
  const ITA_FLAGS: IndexEntryFlags = { ...STAGE0_FLAGS, intentToAdd: true };

  describe('Given an index with a skip-worktree entry', () => {
    describe('When serializing', () => {
      it('Then the header version is 3', () => {
        // Arrange
        const index: GitIndex = {
          version: 2,
          entries: [makeEntry('sparse.txt', SHA_A, SKIP_FLAGS)],
          extensions: [],
          trailerSha: new Uint8Array(0),
        };

        // Act
        const result = serializeIndex(index, 20);

        // Assert — the on-disk version is derived from the entries, not the
        // informational `index.version` field (which is 2 here).
        const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
        expect(view.getUint32(4)).toBe(3);
      });
    });
  });

  describe('Given an index with no extended entry', () => {
    describe('When serializing', () => {
      it('Then the header version is 2', () => {
        // Arrange — every entry is a plain stage-0 entry.
        const index: GitIndex = {
          version: 3,
          entries: [makeEntry('plain.txt')],
          extensions: [],
          trailerSha: new Uint8Array(0),
        };

        // Act
        const result = serializeIndex(index, 20);

        // Assert — even though `index.version` is 3, no entry needs extended
        // flags so the minimum on-disk version (2) is chosen.
        const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
        expect(view.getUint32(4)).toBe(2);
      });
    });
  });

  describe('Given a skip-worktree entry', () => {
    describe('When serializing', () => {
      it('Then the flags word sets the extended bit and the extended word sets 0x4000', () => {
        // Arrange
        const index: GitIndex = {
          version: 3,
          entries: [makeEntry('sparse.txt', SHA_A, SKIP_FLAGS)],
          extensions: [],
          trailerSha: new Uint8Array(0),
        };

        // Act
        const result = serializeIndex(index, 20);
        const view = new DataView(result.buffer, result.byteOffset, result.byteLength);

        // Assert — flags word (offset 12+60) has the 0x4000 extended bit; the
        // extended-flags word (offset 12+62) carries the skip-worktree bit.
        expect(view.getUint16(12 + 60) & 0x4000).toBe(0x4000);
        expect(view.getUint16(12 + 62)).toBe(0x4000);
      });
    });
  });

  describe('Given an intent-to-add entry', () => {
    describe('When serializing', () => {
      it('Then the extended word sets 0x2000', () => {
        // Arrange
        const index: GitIndex = {
          version: 3,
          entries: [makeEntry('staged.txt', SHA_A, ITA_FLAGS)],
          extensions: [],
          trailerSha: new Uint8Array(0),
        };

        // Act
        const result = serializeIndex(index, 20);
        const view = new DataView(result.buffer, result.byteOffset, result.byteLength);

        // Assert
        expect(view.getUint16(12 + 62)).toBe(0x2000);
      });
    });
  });

  describe('Given a skip-worktree entry', () => {
    describe('When serializing then parsing', () => {
      it('Then the skipWorktree bit round-trips and the padded entry is 8-byte aligned', () => {
        // Arrange — a path length chosen so the extra 2-byte extended word makes
        // the 8-byte boundary observable: 62 + 2 + 9 ('sparse.ts') = 73 → padded
        // to 80, a different total than the same path without the extended word.
        const index: GitIndex = {
          version: 3,
          entries: [makeEntry('sparse.ts', SHA_A, SKIP_FLAGS)],
          extensions: [],
          trailerSha: new Uint8Array(0),
        };

        // Act
        const serialized = serializeIndex(index, 20);
        const result = parseIndex(withChecksum(serialized), 20);

        // Assert — round-trip preserves the bit; the padded entry stays aligned.
        expect((serialized.length - 12) % 8).toBe(0);
        expect(result.entries[0]?.flags.skipWorktree).toBe(true);
        expect(result.entries[0]?.flags.intentToAdd).toBe(false);
        expect(result.entries[0]?.path).toBe('sparse.ts');
      });
    });
  });

  describe('Given a v2 index with several plain entries', () => {
    describe('When serializing then parsing', () => {
      it('Then the index round-trips deep-equal', () => {
        // Arrange
        const index: GitIndex = {
          version: 2,
          entries: [makeEntry('a.txt'), makeEntry('b.txt', 'b'.repeat(40) as ObjectId)],
          extensions: [],
          trailerSha: new Uint8Array(0),
        };

        // Act
        const result = parseIndex(withChecksum(serializeIndex(index, 20)), 20);

        // Assert — version derived back to 2; entries identical after path sort.
        expect(result).toEqual({
          version: 2,
          entries: [...index.entries].sort((l, r) =>
            (l.path as string) < (r.path as string) ? -1 : 1,
          ),
          extensions: [],
          trailerSha: CHECKSUM,
        });
      });
    });
  });

  describe('Given a v3 index with skip-worktree and intent-to-add entries', () => {
    describe('When serializing then parsing', () => {
      it('Then the index round-trips deep-equal', () => {
        // Arrange — a mix of plain, skip-worktree and intent-to-add entries.
        const index: GitIndex = {
          version: 3,
          entries: [
            makeEntry('keep.txt'),
            makeEntry('skip.txt', 'b'.repeat(40) as ObjectId, SKIP_FLAGS),
            makeEntry('ita.txt', 'c'.repeat(40) as ObjectId, ITA_FLAGS),
          ],
          extensions: [],
          trailerSha: new Uint8Array(0),
        };

        // Act
        const result = parseIndex(withChecksum(serializeIndex(index, 20)), 20);

        // Assert — version derived back to 3; every entry (and its flags)
        // survives the parse/serialize cycle byte-for-byte.
        expect(result).toEqual({
          version: 3,
          entries: [...index.entries].sort((l, r) =>
            (l.path as string) < (r.path as string) ? -1 : 1,
          ),
          extensions: [],
          trailerSha: CHECKSUM,
        });
      });
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
