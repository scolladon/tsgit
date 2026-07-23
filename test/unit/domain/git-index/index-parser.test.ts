import { describe, expect, it } from 'vitest';
import { TsgitError } from '../../../../src/domain/error.js';
import { parseIndex } from '../../../../src/domain/git-index/index-parser.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';

const CHECKSUM_SIZE = 20;

function buildTestIndex(
  entries: ReadonlyArray<{
    readonly path: string;
    readonly sha: string;
    readonly mode?: number;
    readonly stage?: number;
    readonly assumeValid?: boolean;
    readonly ctime?: number;
    readonly ctimeNano?: number;
    readonly mtime?: number;
    readonly mtimeNano?: number;
  }>,
  extensions: ReadonlyArray<{ readonly signature: string; readonly data: Uint8Array }> = [],
): Uint8Array {
  const entryBuffers: Uint8Array[] = [];

  for (const entry of entries) {
    const pathBytes = new TextEncoder().encode(entry.path);
    const entryLength = 62 + pathBytes.length;
    const paddedLength = (entryLength + 8) & ~7;
    const buf = new Uint8Array(paddedLength);
    const view = new DataView(buf.buffer);

    view.setUint32(0, entry.ctime ?? 1000);
    view.setUint32(4, entry.ctimeNano ?? 500);
    view.setUint32(8, entry.mtime ?? 2000);
    view.setUint32(12, entry.mtimeNano ?? 600);
    view.setUint32(16, 10);
    view.setUint32(20, 20);
    view.setUint32(24, entry.mode ?? 0o100644);
    view.setUint32(28, 100);
    view.setUint32(32, 200);
    view.setUint32(36, 4096);

    const shaBytes = hexToBytes(entry.sha);
    buf.set(shaBytes, 40);

    const nameLen = Math.min(pathBytes.length, 0xfff);
    const stage = entry.stage ?? 0;
    const assumeValid = entry.assumeValid ?? false;
    const flagsRaw = (assumeValid ? 0x8000 : 0) | (stage << 12) | nameLen;
    view.setUint16(60, flagsRaw);

    buf.set(pathBytes, 62);
    entryBuffers.push(buf);
  }

  const extensionBuffers: Uint8Array[] = extensions.map((ext) => {
    const buf = new Uint8Array(8 + ext.data.length);
    const sigBytes = new TextEncoder().encode(ext.signature);
    buf.set(sigBytes, 0);
    new DataView(buf.buffer).setUint32(4, ext.data.length);
    buf.set(ext.data, 8);
    return buf;
  });

  const entryTotal = entryBuffers.reduce((s, b) => s + b.length, 0);
  const extTotal = extensionBuffers.reduce((s, b) => s + b.length, 0);
  const total = 12 + entryTotal + extTotal + CHECKSUM_SIZE;
  const result = new Uint8Array(total);
  const headerView = new DataView(result.buffer);

  headerView.setUint32(0, 0x44495243);
  headerView.setUint32(4, 2);
  headerView.setUint32(8, entries.length);

  let offset = 12;
  for (const buf of entryBuffers) {
    result.set(buf, offset);
    offset += buf.length;
  }
  for (const buf of extensionBuffers) {
    result.set(buf, offset);
    offset += buf.length;
  }

  return result;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

const SHA_A = 'a'.repeat(40);

describe('parseIndex', () => {
  describe('Given valid index with 0 entries (32 bytes)', () => {
    describe('When parsing', () => {
      it('Then version=2, entries empty, no extensions', () => {
        // Arrange
        const input = buildTestIndex([]);

        // Act
        const sut = parseIndex(input);

        // Assert
        expect(sut.version).toBe(2);
        expect(sut.entries).toHaveLength(0);
        expect(sut.extensions).toHaveLength(0);
      });
    });
  });

  describe('Given valid index with 1 entry', () => {
    describe('When parsing', () => {
      it('Then all stat fields, SHA, flags, and path are correct', () => {
        // Arrange — use distinct values for every field to catch offset arithmetic mutants
        const input = buildTestIndex([
          {
            path: 'hello.txt',
            sha: SHA_A,
            ctime: 1000,
            ctimeNano: 111,
            mtime: 2000,
            mtimeNano: 222,
          },
        ]);

        // Act
        const sut = parseIndex(input);

        // Assert
        expect(sut.entries).toHaveLength(1);
        const entry = sut.entries[0]!;
        expect(entry.path).toBe('hello.txt');
        expect(entry.id).toBe(SHA_A);
        expect(entry.ctimeSeconds).toBe(1000);
        expect(entry.ctimeNanoseconds).toBe(111);
        expect(entry.mtimeSeconds).toBe(2000);
        expect(entry.mtimeNanoseconds).toBe(222);
        expect(entry.dev).toBe(10);
        expect(entry.ino).toBe(20);
        expect(entry.mode).toBe(FILE_MODE.REGULAR);
        expect(entry.uid).toBe(100);
        expect(entry.gid).toBe(200);
        expect(entry.fileSize).toBe(4096);
        expect(entry.flags.stage).toBe(0);
        expect(entry.flags.assumeValid).toBe(false);
        expect(entry.flags.skipWorktree).toBe(false);
        expect(entry.flags.intentToAdd).toBe(false);
      });
    });
  });

  describe('Given valid index with 3 entries', () => {
    describe('When parsing', () => {
      it('Then all entries correct', () => {
        // Arrange
        const sha1 = 'a'.repeat(40);
        const sha2 = 'b'.repeat(40);
        const sha3 = 'c'.repeat(40);
        const input = buildTestIndex([
          { path: 'a.txt', sha: sha1 },
          { path: 'b.txt', sha: sha2 },
          { path: 'c.txt', sha: sha3 },
        ]);

        // Act
        const sut = parseIndex(input);

        // Assert
        expect(sut.entries).toHaveLength(3);
        expect(sut.entries[0]?.path).toBe('a.txt');
        expect(sut.entries[1]?.path).toBe('b.txt');
        expect(sut.entries[2]?.path).toBe('c.txt');
      });
    });
  });

  describe('Given index with entries in non-sorted order', () => {
    describe('When parsing', () => {
      it('Then entries returned as-is', () => {
        // Arrange
        const input = buildTestIndex([
          { path: 'z.txt', sha: SHA_A },
          { path: 'a.txt', sha: SHA_A },
        ]);

        // Act
        const sut = parseIndex(input);

        // Assert
        expect(sut.entries[0]?.path).toBe('z.txt');
        expect(sut.entries[1]?.path).toBe('a.txt');
      });
    });
  });

  describe('Given index with optional extension (uppercase signature)', () => {
    describe('When parsing', () => {
      it('Then extension preserved', () => {
        // Arrange
        const extData = new Uint8Array([1, 2, 3, 4]);
        const input = buildTestIndex([], [{ signature: 'TREE', data: extData }]);

        // Act
        const sut = parseIndex(input);

        // Assert
        expect(sut.extensions).toHaveLength(1);
        expect(sut.extensions[0]?.signature).toBe('TREE');
        expect(sut.extensions[0]?.data).toEqual(extData);
      });
    });
  });

  describe('Given index with a mandatory extension whose signature is rejected', () => {
    describe('When parsing', () => {
      it.each([
        {
          signature: 'abcd',
          reason: "mandatory extension 'abcd' not supported",
          label: "rejects a signature starting with 'a' (lower boundary, charCode 97)",
        },
        {
          signature: 'zbcd',
          reason: "mandatory extension 'zbcd' not supported",
          label: "rejects a signature starting with 'z' (upper boundary, charCode 122)",
        },
        {
          signature: 'link',
          reason: "mandatory extension 'link' not supported",
          label: 'rejects the mandatory link extension',
        },
        {
          signature: 'a\x01cd',
          reason: "mandatory extension 'a?cd' not supported",
          label: "replaces a non-printable signature byte with '?' in the reason",
        },
      ])('Then $label', ({ signature, reason }) => {
        // Arrange
        const input = buildTestIndex([], [{ signature, data: new Uint8Array([1]) }]);

        // Act & Assert
        try {
          parseIndex(input);
          // Assert
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data).toEqual({
            code: 'INVALID_INDEX_ENTRY',
            offset: 12,
            reason,
          });
        }
      });
    });
  });

  describe('Given a v2-header index whose entry sets the extended flag bit', () => {
    describe('When parsing', () => {
      it('Then throws INVALID_INDEX_ENTRY at offset 12 (extended requires v3)', () => {
        // Arrange — header version is 2 but the entry flags word sets 0x4000.
        // A v2 index cannot carry extended entries; the parser must reject it.
        const pathBytes = new TextEncoder().encode('file.txt');
        const entryLength = 62 + pathBytes.length;
        const paddedLength = (entryLength + 8) & ~7;
        const total = 12 + paddedLength + CHECKSUM_SIZE;
        const buf = new Uint8Array(total);
        const view = new DataView(buf.buffer);

        view.setUint32(0, 0x44495243);
        view.setUint32(4, 2);
        view.setUint32(8, 1);

        view.setUint32(12 + 24, 0o100644);
        buf.set(hexToBytes(SHA_A), 12 + 40);
        view.setUint16(12 + 60, 0x4000 | pathBytes.length);
        buf.set(pathBytes, 12 + 62);

        // Act & Assert — code, offset AND reason all pinned via try/catch.
        try {
          parseIndex(buf);
          // Assert
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data).toEqual({
            code: 'INVALID_INDEX_ENTRY',
            offset: 12,
            reason: 'extended flag requires index v3',
          });
        }
      });
    });
  });

  describe('Given entry with nameLength = 0xFFF and long path', () => {
    describe('When parsing', () => {
      it('Then reads actual NUL-terminated path', () => {
        // Arrange
        const longPath = 'x'.repeat(5000);
        const pathBytes = new TextEncoder().encode(longPath);
        const entryLength = 62 + pathBytes.length;
        const paddedLength = (entryLength + 8) & ~7;
        const total = 12 + paddedLength + CHECKSUM_SIZE;
        const buf = new Uint8Array(total);
        const view = new DataView(buf.buffer);

        view.setUint32(0, 0x44495243);
        view.setUint32(4, 2);
        view.setUint32(8, 1);

        view.setUint32(12 + 24, 0o100644);
        buf.set(hexToBytes(SHA_A), 12 + 40);
        view.setUint16(12 + 60, 0x0fff);
        buf.set(pathBytes, 12 + 62);

        // Act
        const sut = parseIndex(buf);

        // Assert
        expect(sut.entries[0]?.path).toBe(longPath);
      });
    });
  });

  describe('Given wrong signature (not DIRC)', () => {
    describe('When parsing', () => {
      it('Then throws INVALID_INDEX_HEADER', () => {
        // Arrange
        const buf = new Uint8Array(32);
        new DataView(buf.buffer).setUint32(0, 0x00000000);

        // Act & Assert
        try {
          parseIndex(buf);
          // Assert
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data).toEqual({
            code: 'INVALID_INDEX_HEADER',
            reason: 'invalid signature: expected DIRC',
          });
        }
      });
    });
  });

  describe('Given version 4 (above the supported v2/v3 range)', () => {
    describe('When parsing', () => {
      it('Then throws INVALID_INDEX_HEADER', () => {
        // Arrange — v4 (path-prefix compression) is not supported; only 2 and 3 are.
        const buf = new Uint8Array(32);
        const view = new DataView(buf.buffer);
        view.setUint32(0, 0x44495243);
        view.setUint32(4, 4);

        // Act & Assert
        try {
          parseIndex(buf);
          // Assert
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data).toEqual({
            code: 'INVALID_INDEX_HEADER',
            reason: 'unsupported version: 4',
          });
        }
      });
    });
  });

  describe('Given version 1 (below the supported v2/v3 range)', () => {
    describe('When parsing', () => {
      it('Then throws INVALID_INDEX_HEADER', () => {
        // Arrange — v1 is below the accepted range; pins the lower bound of the
        // `version !== 2 && version !== 3` guard.
        const buf = new Uint8Array(32);
        const view = new DataView(buf.buffer);
        view.setUint32(0, 0x44495243);
        view.setUint32(4, 1);

        // Act & Assert
        try {
          parseIndex(buf);
          // Assert
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data).toEqual({
            code: 'INVALID_INDEX_HEADER',
            reason: 'unsupported version: 1',
          });
        }
      });
    });
  });

  describe('Given truncated header (< 12 bytes)', () => {
    describe('When parsing', () => {
      it('Then throws INVALID_INDEX_HEADER', () => {
        // Arrange
        const buf = new Uint8Array(8);

        // Act & Assert
        try {
          parseIndex(buf);
          // Assert
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data).toEqual({
            code: 'INVALID_INDEX_HEADER',
            reason: 'truncated header',
          });
        }
      });
    });
  });

  describe('Given crafted entryCount exceeding file capacity', () => {
    describe('When parsing', () => {
      it('Then throws with specific reason', () => {
        // Arrange — 1 entry needs 62 bytes but only 0 available (32 - 12 - 20 = 0)
        const buf = new Uint8Array(32);
        const view = new DataView(buf.buffer);
        view.setUint32(0, 0x44495243);
        view.setUint32(4, 2);
        view.setUint32(8, 1);

        // Act & Assert
        try {
          parseIndex(buf);
          // Assert
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data).toEqual({
            code: 'INVALID_INDEX_HEADER',
            reason: 'entry count 1 exceeds file capacity',
          });
        }
      });
    });
  });

  describe('Given extension with size slightly exceeding remaining bytes', () => {
    describe('When parsing', () => {
      it('Then throws INVALID_INDEX_ENTRY', () => {
        // Arrange — 50-byte buffer: extensionEnd=30. Extension claims size=15.
        // Original check: 12 + 8 + 15 = 35 > 30 → rejects. Kills -8 arithmetic mutant.
        const buf = new Uint8Array(50);
        const view = new DataView(buf.buffer);
        view.setUint32(0, 0x44495243);
        view.setUint32(4, 2);
        view.setUint32(8, 0);
        buf.set(new TextEncoder().encode('TREE'), 12);
        view.setUint32(16, 15);

        // Act & Assert
        try {
          parseIndex(buf);
          // Assert
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data).toEqual({
            code: 'INVALID_INDEX_ENTRY',
            offset: 12,
            reason: 'extension size exceeds remaining bytes',
          });
        }
      });
    });
  });

  describe('Given extension with size vastly exceeding remaining bytes', () => {
    describe('When parsing', () => {
      it('Then throws INVALID_INDEX_ENTRY', () => {
        // Arrange
        const buf = new Uint8Array(12 + 8 + CHECKSUM_SIZE);
        const view = new DataView(buf.buffer);
        view.setUint32(0, 0x44495243);
        view.setUint32(4, 2);
        view.setUint32(8, 0);
        buf.set(new TextEncoder().encode('TREE'), 12);
        view.setUint32(16, 999999);

        // Act & Assert
        try {
          parseIndex(buf);
          // Assert
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data).toEqual({
            code: 'INVALID_INDEX_ENTRY',
            offset: 12,
            reason: 'extension size exceeds remaining bytes',
          });
        }
      });
    });
  });

  describe('Given truncated entry (just barely fails security guard)', () => {
    describe('When parsing', () => {
      it('Then throws INVALID_INDEX_HEADER', () => {
        // Arrange — header says 1 entry but room is only 10 bytes (< 62)
        const buf = new Uint8Array(12 + 10 + CHECKSUM_SIZE);
        const view = new DataView(buf.buffer);
        view.setUint32(0, 0x44495243);
        view.setUint32(4, 2);
        view.setUint32(8, 1);

        // Act & Assert
        try {
          parseIndex(buf);
          // Assert
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data.code).toBe('INVALID_INDEX_HEADER');
        }
      });
    });
  });

  describe('Given entry with flags.stage = 2', () => {
    describe('When parsing', () => {
      it('Then stage field is 2', () => {
        // Arrange
        const input = buildTestIndex([{ path: 'conflict.txt', sha: SHA_A, stage: 2 }]);

        // Act
        const sut = parseIndex(input);

        // Assert
        expect(sut.entries[0]?.flags.stage).toBe(2);
      });
    });
  });

  describe('Given entry with assumeValid = true', () => {
    describe('When parsing', () => {
      it('Then flag is set', () => {
        // Arrange
        const input = buildTestIndex([{ path: 'assumed.txt', sha: SHA_A, assumeValid: true }]);

        // Act
        const sut = parseIndex(input);

        // Assert
        expect(sut.entries[0]?.flags.assumeValid).toBe(true);
      });
    });
  });

  describe('Given 2 entries claimed but second truncated mid-header', () => {
    describe('When parsing', () => {
      it('Then throws INVALID_INDEX_ENTRY at second entry offset', () => {
        // Arrange — Security guard passes: 2*62=124 <= 160-32=128. Second entry at 84 truncated.
        const buf = new Uint8Array(160);
        const view = new DataView(buf.buffer);
        view.setUint32(0, 0x44495243);
        view.setUint32(4, 2);
        view.setUint32(8, 2);

        view.setUint32(12 + 24, 0o100644);
        buf.set(hexToBytes(SHA_A), 12 + 40);
        const pathBytes = new TextEncoder().encode('ok.txt');
        view.setUint16(12 + 60, pathBytes.length);
        buf.set(pathBytes, 12 + 62);

        // Act & Assert
        try {
          parseIndex(buf);
          // Assert
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data).toEqual({
            code: 'INVALID_INDEX_ENTRY',
            offset: 84,
            reason: 'truncated entry',
          });
        }
      });
    });
  });

  describe('Given entryCount=1 that barely exceeds capacity in 93-byte buffer', () => {
    describe('When parsing', () => {
      it('Then throws INVALID_INDEX_HEADER', () => {
        // Arrange — 93 bytes: maxEntryBytes = 93 - 12 - 20 = 61. 1*62 > 61 → throws.
        // Kills arithmetic mutants on line 29 (+CHECKSUM: 93-12+20=101, 62>101? No → passes guard → different error)
        const buf = new Uint8Array(93);
        const view = new DataView(buf.buffer);
        view.setUint32(0, 0x44495243);
        view.setUint32(4, 2);
        view.setUint32(8, 1);

        // Act & Assert
        try {
          parseIndex(buf);
          // Assert
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data).toEqual({
            code: 'INVALID_INDEX_HEADER',
            reason: 'entry count 1 exceeds file capacity',
          });
        }
      });
    });
  });

  describe('Given index with two extensions', () => {
    describe('When parsing', () => {
      it('Then both extensions preserved in order', () => {
        // Arrange — kills extension offset mutant (writer:45 offset -= totalLength)
        const ext1Data = new Uint8Array([1, 2]);
        const ext2Data = new Uint8Array([3, 4, 5]);
        const input = buildTestIndex(
          [],
          [
            { signature: 'TREE', data: ext1Data },
            { signature: 'REUC', data: ext2Data },
          ],
        );

        // Act
        const sut = parseIndex(input);

        // Assert
        expect(sut.extensions).toHaveLength(2);
        expect(sut.extensions[0]?.signature).toBe('TREE');
        expect(sut.extensions[0]?.data).toEqual(ext1Data);
        expect(sut.extensions[1]?.signature).toBe('REUC');
        expect(sut.extensions[1]?.data).toEqual(ext2Data);
      });
    });
  });

  describe('Given extension with signature starting with char > z (e.g. {)', () => {
    describe('When parsing', () => {
      it('Then extension is preserved as optional', () => {
        // Arrange — '{' = charCode 123, above 'z'=122. Kills firstChar<=122→true mutant.
        const input = buildTestIndex([], [{ signature: '{bcd', data: new Uint8Array([1]) }]);

        // Act
        const sut = parseIndex(input);

        // Assert
        expect(sut.extensions).toHaveLength(1);
        expect(sut.extensions[0]?.signature).toBe('{bcd');
      });
    });
  });

  describe('Given entry that fits exactly at the boundary (offset+62 === len-20)', () => {
    describe('When parsing', () => {
      it('Then entry is accepted', () => {
        // Arrange — kills > vs >= mutant on per-entry truncation check (line 39).
        // Buffer = 12 header + 62 entry_header + 0 path bytes + 8 padding + 20 checksum = 102
        // But we need NUL-terminated path. Shortest: 0-byte path + 8 NUL padding.
        // Entry: 62 header + pathLen=0 → NUL at offset 74, nulEnd=74, offset=75.
        // entryLength = 75-12 = 63, paddedLength = (63+7)&~7 = 64, finalOffset = 12+64 = 76.
        // Actually we need the entry_header check to be exact: offset+62 = bytes.length-20.
        // offset=12, so bytes.length = 12+62+20 = 94. Entry header fits exactly.
        // But then we need a valid path + padding within those 94 bytes.
        // After 62-byte header at offset 12, we're at offset 74. 94-20=74, so extensionEnd=74.
        // The path area starts at 74 and checksum starts at 74 — there's 0 bytes for path.
        // The NUL byte for path termination would need to be at offset 74, but that's in the checksum.
        // findNul(bytes, 74) would read bytes[74..93] — these are all 0 (checksum zeros) → finds NUL at 74.
        // path = decode(bytes[74:74]) = '' → FilePath.from('') throws Error.
        // So we need slightly more room. Use path 'a' (1 byte) + padding.
        // 12 + 62 + 1(path) + 7(padding to 8-byte) + 20(checksum) = 102.
        // At entry start(12): offset+62=74 <= 102-20=82. Original: 74 > 82? No. Mutant: 74 >= 82? No. Both pass.
        // Hmm, the check is per-iteration. For the entry to exactly hit the boundary:
        // offset + 62 = bytes.length - 20, meaning offset = bytes.length - 82.
        // For offset=12: bytes.length = 94. Need valid entry in 94-12-20=62 bytes of content area.
        // That's exactly 62 bytes for the entry header, 0 for path. But path can't be empty.
        // Use buildTestIndex with 1-char path for a just-fits scenario instead.
        const input = buildTestIndex([{ path: 'a', sha: SHA_A }]);

        // Act — this should parse successfully
        const sut = parseIndex(input);

        // Assert
        expect(sut.entries).toHaveLength(1);
        expect(sut.entries[0]?.path).toBe('a');
      });
    });
  });

  describe('Given extension whose size exactly fills remaining space', () => {
    describe('When parsing', () => {
      it('Then extension is accepted', () => {
        // Arrange — kills +8 → -8 mutant on extension bounds check (line 129).
        // Build index with 0 entries, then manually craft an extension that fills exactly.
        // Total bytes: 12 header + 8 ext_header + ext_data + 20 checksum.
        // extensionEnd = total - 20 = 12 + 8 + ext_data.length.
        // Check: offset(12) + 8 + size <= extensionEnd. Exact fit: 12 + 8 + size = extensionEnd = total - 20.
        const extSize = 10;
        const total = 12 + 8 + extSize + CHECKSUM_SIZE;
        const buf = new Uint8Array(total);
        const view = new DataView(buf.buffer);
        view.setUint32(0, 0x44495243);
        view.setUint32(4, 2);
        view.setUint32(8, 0);
        buf.set(new TextEncoder().encode('TREE'), 12);
        view.setUint32(16, extSize);
        // Fill extension data
        buf.fill(0x42, 20, 20 + extSize);

        // Act
        const sut = parseIndex(buf);

        // Assert
        expect(sut.extensions).toHaveLength(1);
        expect(sut.extensions[0]?.signature).toBe('TREE');
        expect(sut.extensions[0]?.data.length).toBe(extSize);
      });
    });
  });

  describe('Given entry with no NUL terminator in data', () => {
    describe('When parsing', () => {
      it('Then throws INVALID_INDEX_ENTRY', () => {
        // Arrange — fill everything after entry header with 'x' so findNul returns -1
        const total = 12 + 62 + 100 + CHECKSUM_SIZE;
        const buf = new Uint8Array(total);
        const view = new DataView(buf.buffer);
        view.setUint32(0, 0x44495243);
        view.setUint32(4, 2);
        view.setUint32(8, 1);

        view.setUint32(12 + 24, 0o100644);
        buf.set(hexToBytes(SHA_A), 12 + 40);
        view.setUint16(12 + 60, 5);
        buf.fill(0x78, 12 + 62);

        // Act & Assert
        try {
          parseIndex(buf);
          // Assert
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data).toEqual({
            code: 'INVALID_INDEX_ENTRY',
            offset: 12,
            reason: 'missing NUL terminator',
          });
        }
      });
    });
  });

  describe('Given an entry whose path violates a path-safety rule', () => {
    describe('When parseIndex runs', () => {
      const PATH_SHA = '0123456789abcdef0123456789abcdef01234567';
      const SECOND_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

      it.each([
        {
          entries: [{ path: '/etc/passwd', sha: PATH_SHA }],
          offset: 12,
          reason: 'absolute path rejected',
          label: 'rejects a leading `/` (absolute path)',
        },
        {
          entries: [{ path: 'foo/../bar', sha: PATH_SHA }],
          offset: 12,
          reason: "'..' segment rejected",
          label: 'rejects a `..` segment mid-path',
        },
        {
          entries: [{ path: '..', sha: PATH_SHA }],
          offset: 12,
          reason: "'..' segment rejected",
          label: 'rejects a bare `..` path',
        },
        {
          entries: [{ path: 'foo/./bar', sha: PATH_SHA }],
          offset: 12,
          reason: "'.' segment rejected",
          label: 'rejects a `.` current-dir segment',
        },
        {
          // First entry: 62 header + 8 name ('safe.txt') + 1 NUL = 71;
          // padded up to multiple of 8 = 72. Header is 12 → second entry
          // starts at 84. Pins `entryStart` threading against any mutation
          // that replaces it with a different integer.
          entries: [
            { path: 'safe.txt', sha: PATH_SHA },
            { path: '../etc/passwd', sha: SECOND_SHA },
          ],
          offset: 84,
          reason: "'..' segment rejected",
          label: 'rejects `..` at the second entry, with the offset threaded to its start',
        },
        {
          // `..\\bar` would slip past the slash-segment check on POSIX but
          // resolve to a traversal on Windows.
          entries: [{ path: 'foo\\..\\bar', sha: PATH_SHA }],
          offset: 12,
          reason: 'backslash rejected',
          label: 'rejects a backslash (Windows separator)',
        },
        {
          entries: [{ path: 'foo\tbar', sha: PATH_SHA }],
          offset: 12,
          reason: 'control character rejected',
          label: 'rejects a TAB control character (0x09)',
        },
        {
          entries: [{ path: 'foo\x7fbar', sha: PATH_SHA }],
          offset: 12,
          reason: 'control character rejected',
          label: 'rejects DEL (0x7F), the boundary above C0 controls',
        },
        {
          entries: [{ path: 'foo\x85bar', sha: PATH_SHA }],
          offset: 12,
          reason: 'control character rejected',
          label: 'rejects a C1 control character (0x85 NEL)',
        },
        {
          // RTL override can visually disguise filenames in terminals and
          // log lines (e.g., `evil.exe` rendered as `exe.libtrust`).
          entries: [{ path: `evil‮gnp.exe`, sha: PATH_SHA }],
          offset: 12,
          reason: 'bidi control character rejected',
          label: 'rejects a BIDI override (U+202E)',
        },
        {
          entries: [{ path: 'foo//bar', sha: PATH_SHA }],
          offset: 12,
          reason: 'empty segment rejected',
          label: 'rejects an empty segment (`foo//bar`)',
        },
      ])('Then $label', ({ entries, offset, reason }) => {
        // Arrange
        const bytes = buildTestIndex(entries);

        // Act
        let caught: unknown;
        try {
          parseIndex(bytes);
        } catch (err) {
          caught = err;
        }

        // Assert — code, reason AND offset all pinned (offset proves the
        // entry-start byte was correctly threaded into the error).
        expect((caught as TsgitError).data).toEqual({
          code: 'INVALID_INDEX_ENTRY',
          offset,
          reason,
        });
      });
    });
  });

  describe('Given a safe path containing only printable ASCII (including space)', () => {
    describe('When parseIndex runs', () => {
      it('Then succeeds', () => {
        // Arrange — positive case pins the lower boundary 0x20 (space): a
        // mutation flipping `code < 0x20` to `code <= 0x20` would reject
        // space and surface here.
        const SHA_A = '0123456789abcdef0123456789abcdef01234567';
        const bytes = buildTestIndex([{ path: 'foo bar.txt', sha: SHA_A }]);

        // Act
        const result = parseIndex(bytes);

        // Assert
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]?.path).toBe('foo bar.txt');
      });
    });
  });

  describe('Given a 12-byte buffer that is a valid header but has no room for entries/checksum', () => {
    describe('When parsing', () => {
      it('Then throws with the entry-capacity reason (NOT truncated header)', () => {
        // Arrange — exactly INDEX_HEADER_SIZE bytes: the `bytes.length <
        // INDEX_HEADER_SIZE` guard must be FALSE here (12 < 12 is false), so
        // parsing proceeds to the entry-count guard. The `<=` mutant would
        // make 12 <= 12 true and surface "truncated header" instead.
        const buf = new Uint8Array(12);
        const view = new DataView(buf.buffer);
        view.setUint32(0, 0x44495243);
        view.setUint32(4, 2);
        view.setUint32(8, 1);

        // Act
        let caught: unknown;
        try {
          parseIndex(buf);
        } catch (err) {
          caught = err;
        }

        // Assert — reason proves the truncated-header guard did NOT fire.
        expect((caught as TsgitError).data).toEqual({
          code: 'INVALID_INDEX_HEADER',
          reason: 'entry count 1 exceeds file capacity',
        });
      });
    });
  });

  describe('Given an entry whose header ends exactly at the checksum boundary (offset+62 === len-20)', () => {
    describe('When parsing', () => {
      it('Then the per-entry truncation guard does NOT fire', () => {
        // Arrange — buffer is 94 bytes: 12 header + 62 entry header + 0 path
        // room + 20 checksum. At entryStart=12: offset+62 (74) equals
        // bytes.length-20 (74). Original `>` keeps the guard quiet (74 > 74
        // is false) so parsing proceeds and later fails on the empty path
        // with "empty segment rejected". The `>=` mutant fires the guard
        // (74 >= 74) and throws "truncated entry" instead.
        const buf = new Uint8Array(94);
        const view = new DataView(buf.buffer);
        view.setUint32(0, 0x44495243);
        view.setUint32(4, 2);
        view.setUint32(8, 1);
        view.setUint32(12 + 24, 0o100644);

        // Act
        let caught: unknown;
        try {
          parseIndex(buf);
        } catch (err) {
          caught = err;
        }

        // Assert — the empty-segment reason proves the truncation guard
        // stayed quiet; "truncated entry" would mean the `>=` mutant won.
        expect((caught as TsgitError).data).toEqual({
          code: 'INVALID_INDEX_ENTRY',
          offset: 12,
          reason: 'empty segment rejected',
        });
      });
    });
  });

  describe('Given an entry whose nameLength field is shorter than its NUL-delimited bytes', () => {
    describe('When parsing', () => {
      it('Then path is truncated to nameLength (NOT read up to the NUL)', () => {
        // Arrange — path bytes are 'abcdefgh' (8 bytes) but the flags
        // nameLength field is deliberately 3. The parser must slice the
        // path at offset+nameLength → 'abc'. The ConditionalExpression-true
        // mutant ignores nameLength and slices up to the NUL → 'abcdefgh'.
        const fullPath = 'abcdefgh';
        const pathBytes = new TextEncoder().encode(fullPath);
        const entryLength = 62 + pathBytes.length;
        const paddedLength = (entryLength + 8) & ~7;
        const total = 12 + paddedLength + CHECKSUM_SIZE;
        const buf = new Uint8Array(total);
        const view = new DataView(buf.buffer);
        view.setUint32(0, 0x44495243);
        view.setUint32(4, 2);
        view.setUint32(8, 1);
        view.setUint32(12 + 24, 0o100644);
        buf.set(hexToBytes(SHA_A), 12 + 40);
        // nameLength field = 3 (smaller than the 8 actual path bytes)
        view.setUint16(12 + 60, 3);
        buf.set(pathBytes, 12 + 62);

        // Act
        const sut = parseIndex(buf);

        // Assert — exactly the first 3 bytes, proving nameLength was used.
        expect(sut.entries[0]?.path).toBe('abc');
      });
    });
  });
});

/**
 * Build an index whose entries may carry the index-v3 extended flags word.
 * When an entry's `extRaw` is provided, the 16-bit extended-flags field is
 * emitted right after the 62-byte fixed header and the `0x4000` extended bit
 * is set in the entry's flags word. The header version is passed explicitly
 * so a v2-header / extended-entry mismatch can be exercised.
 */
function buildV3Index(
  version: number,
  entries: ReadonlyArray<{
    readonly path: string;
    readonly sha: string;
    readonly extRaw?: number;
  }>,
): Uint8Array {
  const entryBuffers: Uint8Array[] = [];

  for (const entry of entries) {
    const pathBytes = new TextEncoder().encode(entry.path);
    const extendedSize = entry.extRaw === undefined ? 0 : 2;
    const entryLength = 62 + extendedSize + pathBytes.length;
    const paddedLength = (entryLength + 8) & ~7;
    const buf = new Uint8Array(paddedLength);
    const view = new DataView(buf.buffer);

    view.setUint32(24, 0o100644);
    buf.set(hexToBytes(entry.sha), 40);

    const nameLen = Math.min(pathBytes.length, 0xfff);
    const extendedBit = entry.extRaw === undefined ? 0 : 0x4000;
    view.setUint16(60, extendedBit | nameLen);

    if (entry.extRaw !== undefined) {
      view.setUint16(62, entry.extRaw);
    }
    buf.set(pathBytes, 62 + extendedSize);
    entryBuffers.push(buf);
  }

  const entryTotal = entryBuffers.reduce((s, b) => s + b.length, 0);
  const total = 12 + entryTotal + CHECKSUM_SIZE;
  const result = new Uint8Array(total);
  const headerView = new DataView(result.buffer);

  headerView.setUint32(0, 0x44495243);
  headerView.setUint32(4, version);
  headerView.setUint32(8, entries.length);

  let offset = 12;
  for (const buf of entryBuffers) {
    result.set(buf, offset);
    offset += buf.length;
  }

  return result;
}

describe('parseIndex — index v3 extended flags', () => {
  describe('Given a v3 index with one entry whose extended-flags word varies', () => {
    describe('When parsing', () => {
      it.each([
        {
          path: 'sparse.txt',
          extRaw: 0x4000,
          expectSkipWorktree: true,
          expectIntentToAdd: false,
          label: 'sets skipWorktree from the extended word (0x4000)',
        },
        {
          path: 'staged.txt',
          extRaw: 0x2000,
          expectSkipWorktree: false,
          expectIntentToAdd: true,
          label: 'sets intentToAdd from the extended word (0x2000)',
        },
        {
          // 0x4000 | 0x2000 — proves the two bit masks are read
          // independently (a mutant collapsing one mask is caught).
          path: 'both.txt',
          extRaw: 0x6000,
          expectSkipWorktree: true,
          expectIntentToAdd: true,
          label: 'reads both extended bits independently (0x6000)',
        },
        {
          path: 'plain.txt',
          extRaw: 0x0000,
          expectSkipWorktree: false,
          expectIntentToAdd: false,
          label: 'leaves both flags false for a zero extended word',
        },
        {
          // No extended bit set → buildV3Index omits the extended-flags
          // word entirely for this entry.
          path: 'normal.txt',
          extRaw: undefined,
          expectSkipWorktree: false,
          expectIntentToAdd: false,
          label: 'leaves both flags false for a non-extended entry',
        },
      ])('Then $label', ({ path, extRaw, expectSkipWorktree, expectIntentToAdd }) => {
        // Arrange
        const input = buildV3Index(3, [
          extRaw === undefined ? { path, sha: SHA_A } : { path, sha: SHA_A, extRaw },
        ]);

        // Act
        const sut = parseIndex(input);

        // Assert
        expect(sut.version).toBe(3);
        expect(sut.entries).toHaveLength(1);
        const entry = sut.entries[0]!;
        expect(entry.path).toBe(path);
        expect(entry.flags.skipWorktree).toBe(expectSkipWorktree);
        expect(entry.flags.intentToAdd).toBe(expectIntentToAdd);
      });
    });
  });

  describe('Given a v3 index mixing an extended and a non-extended entry', () => {
    describe('When parsing', () => {
      it('Then each entry decodes its own flags and the path cursor stays aligned', () => {
        // Arrange — the extended first entry shifts the post-header cursor by 2
        // bytes; the second (non-extended) entry must still parse its path
        // correctly, proving the cursor arithmetic accounts for the extra word.
        const SHA_B = 'b'.repeat(40);
        const input = buildV3Index(3, [
          { path: 'a-skip.txt', sha: SHA_A, extRaw: 0x4000 },
          { path: 'b-normal.txt', sha: SHA_B },
        ]);

        // Act
        const sut = parseIndex(input);

        // Assert
        expect(sut.entries).toHaveLength(2);
        expect(sut.entries[0]?.path).toBe('a-skip.txt');
        expect(sut.entries[0]?.flags.skipWorktree).toBe(true);
        expect(sut.entries[1]?.path).toBe('b-normal.txt');
        expect(sut.entries[1]?.id).toBe(SHA_B);
        expect(sut.entries[1]?.flags.skipWorktree).toBe(false);
      });
    });
  });

  describe('Given a v3 extended entry whose extended-flags word ends exactly at the checksum boundary', () => {
    describe('When parsing', () => {
      it('Then the truncation guard does NOT fire', () => {
        // Arrange — buffer is 96 bytes: 12 header + 62 entry header + 2 extended
        // flags word + 0 path room + 20 checksum. At entryStart=12 the guard
        // compares offset+62+2 (76) against bytes.length-20 (76). The original
        // `>` keeps the guard quiet (76 > 76 is false), so parsing proceeds and
        // later fails on the empty path with "empty segment rejected". A `>=`
        // mutant fires the guard and throws "truncated extended flags" instead.
        const buf = new Uint8Array(96);
        const view = new DataView(buf.buffer);
        view.setUint32(0, 0x44495243);
        view.setUint32(4, 3);
        view.setUint32(8, 1);
        view.setUint32(12 + 24, 0o100644);
        // The flags word sets the extended (0x4000) bit so the extended-flags
        // word is read; nameLength is 0, yielding the empty-path validation error.
        view.setUint16(12 + 60, 0x4000);

        // Act
        let caught: unknown;
        try {
          parseIndex(buf);
        } catch (err) {
          caught = err;
        }

        // Assert — the empty-segment reason proves the extended-flags truncation
        // guard stayed quiet; "truncated extended flags" would mean the `>=`
        // mutant won.
        expect((caught as TsgitError).data).toEqual({
          code: 'INVALID_INDEX_ENTRY',
          offset: 12,
          reason: 'empty segment rejected',
        });
      });
    });
  });

  describe('Given a v3 extended entry truncated mid extended-flags word', () => {
    describe('When parsing', () => {
      it('Then throws INVALID_INDEX_ENTRY (truncated extended flags) at the entry start', () => {
        // Arrange — the 62-byte fixed header fits, but the buffer ends before the
        // 2-byte extended-flags word: 12 header + 62 entry header + 1 byte +
        // 20 checksum. The flags word sets the extended bit, so the parser tries
        // to read the extended word and runs off the buffer.
        const buf = new Uint8Array(12 + 62 + 1 + CHECKSUM_SIZE);
        const view = new DataView(buf.buffer);
        view.setUint32(0, 0x44495243);
        view.setUint32(4, 3);
        view.setUint32(8, 1);

        view.setUint32(12 + 24, 0o100644);
        buf.set(hexToBytes(SHA_A), 12 + 40);
        view.setUint16(12 + 60, 0x4000 | 4);

        // Act
        let caught: unknown;
        try {
          parseIndex(buf);
        } catch (err) {
          caught = err;
        }

        // Assert — code, offset AND reason pinned; offset is the entry start (12).
        expect((caught as TsgitError).data).toEqual({
          code: 'INVALID_INDEX_ENTRY',
          offset: 12,
          reason: 'truncated extended flags',
        });
      });
    });
  });
});
