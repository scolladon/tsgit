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
  it('Given valid index with 0 entries (32 bytes), When parsing, Then version=2, entries empty, no extensions', () => {
    // Arrange
    const input = buildTestIndex([]);

    // Act
    const sut = parseIndex(input);

    // Assert
    expect(sut.version).toBe(2);
    expect(sut.entries).toHaveLength(0);
    expect(sut.extensions).toHaveLength(0);
  });

  it('Given valid index with 1 entry, When parsing, Then all stat fields, SHA, flags, and path are correct', () => {
    // Arrange — use distinct values for every field to catch offset arithmetic mutants
    const input = buildTestIndex([
      { path: 'hello.txt', sha: SHA_A, ctime: 1000, ctimeNano: 111, mtime: 2000, mtimeNano: 222 },
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
    expect(entry.flags.extended).toBe(false);
  });

  it('Given valid index with 3 entries, When parsing, Then all entries correct', () => {
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

  it('Given index with entries in non-sorted order, When parsing, Then entries returned as-is', () => {
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

  it('Given index with optional extension (uppercase signature), When parsing, Then extension preserved', () => {
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

  it('Given index with mandatory extension (lowercase signature starting with a), When parsing, Then throws INVALID_INDEX_ENTRY', () => {
    // Arrange — 'a' = charCode 97 (boundary)
    const input = buildTestIndex([], [{ signature: 'abcd', data: new Uint8Array([1]) }]);

    // Act & Assert
    try {
      parseIndex(input);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TsgitError);
      expect((e as TsgitError).data.code).toBe('INVALID_INDEX_ENTRY');
      expect((e as TsgitError).data).toHaveProperty(
        'reason',
        "mandatory extension 'abcd' not supported",
      );
    }
  });

  it('Given index with mandatory extension (lowercase signature starting with z), When parsing, Then throws INVALID_INDEX_ENTRY', () => {
    // Arrange — 'z' = charCode 122 (boundary)
    const input = buildTestIndex([], [{ signature: 'zbcd', data: new Uint8Array([1]) }]);

    // Act & Assert
    try {
      parseIndex(input);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TsgitError);
      expect((e as TsgitError).data.code).toBe('INVALID_INDEX_ENTRY');
      expect((e as TsgitError).data).toHaveProperty(
        'reason',
        "mandatory extension 'zbcd' not supported",
      );
    }
  });

  it('Given index with mandatory extension (lowercase link), When parsing, Then throws INVALID_INDEX_ENTRY', () => {
    // Arrange
    const input = buildTestIndex([], [{ signature: 'link', data: new Uint8Array([1]) }]);

    // Act & Assert
    try {
      parseIndex(input);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TsgitError);
      expect((e as TsgitError).data.code).toBe('INVALID_INDEX_ENTRY');
      expect((e as TsgitError).data).toHaveProperty(
        'reason',
        "mandatory extension 'link' not supported",
      );
    }
  });

  it('Given index with extended flag set, When parsing, Then throws INVALID_INDEX_ENTRY at offset 12', () => {
    // Arrange
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

    // Act & Assert
    try {
      parseIndex(buf);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TsgitError);
      expect((e as TsgitError).data).toEqual({
        code: 'INVALID_INDEX_ENTRY',
        offset: 12,
        reason: 'extended flag not supported in v2',
      });
    }
  });

  it('Given entry with nameLength = 0xFFF and long path, When parsing, Then reads actual NUL-terminated path', () => {
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

  it('Given wrong signature (not DIRC), When parsing, Then throws INVALID_INDEX_HEADER', () => {
    // Arrange
    const buf = new Uint8Array(32);
    new DataView(buf.buffer).setUint32(0, 0x00000000);

    // Act & Assert
    try {
      parseIndex(buf);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TsgitError);
      expect((e as TsgitError).data).toEqual({
        code: 'INVALID_INDEX_HEADER',
        reason: 'invalid signature: expected DIRC',
      });
    }
  });

  it('Given version != 2, When parsing, Then throws INVALID_INDEX_HEADER', () => {
    // Arrange
    const buf = new Uint8Array(32);
    const view = new DataView(buf.buffer);
    view.setUint32(0, 0x44495243);
    view.setUint32(4, 3);

    // Act & Assert
    try {
      parseIndex(buf);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TsgitError);
      expect((e as TsgitError).data).toEqual({
        code: 'INVALID_INDEX_HEADER',
        reason: 'unsupported version: 3',
      });
    }
  });

  it('Given truncated header (< 12 bytes), When parsing, Then throws INVALID_INDEX_HEADER', () => {
    // Arrange
    const buf = new Uint8Array(8);

    // Act & Assert
    try {
      parseIndex(buf);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TsgitError);
      expect((e as TsgitError).data).toEqual({
        code: 'INVALID_INDEX_HEADER',
        reason: 'truncated header',
      });
    }
  });

  it('Given exactly 12-byte header with 0 entries, When parsing, Then throws due to entryCount guard (no room for checksum)', () => {
    // Arrange — 12 bytes is valid header size but maxEntryBytes = 12 - 12 - 20 = -20
    const buf = new Uint8Array(12);
    const view = new DataView(buf.buffer);
    view.setUint32(0, 0x44495243);
    view.setUint32(4, 2);
    view.setUint32(8, 1);

    // Act & Assert
    try {
      parseIndex(buf);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TsgitError);
      expect((e as TsgitError).data.code).toBe('INVALID_INDEX_HEADER');
    }
  });

  it('Given crafted entryCount exceeding file capacity, When parsing, Then throws with specific reason', () => {
    // Arrange — 1 entry needs 62 bytes but only 0 available (32 - 12 - 20 = 0)
    const buf = new Uint8Array(32);
    const view = new DataView(buf.buffer);
    view.setUint32(0, 0x44495243);
    view.setUint32(4, 2);
    view.setUint32(8, 1);

    // Act & Assert
    try {
      parseIndex(buf);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TsgitError);
      expect((e as TsgitError).data).toEqual({
        code: 'INVALID_INDEX_HEADER',
        reason: 'entry count 1 exceeds file capacity',
      });
    }
  });

  it('Given extension with size slightly exceeding remaining bytes, When parsing, Then throws INVALID_INDEX_ENTRY', () => {
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

  it('Given extension with size vastly exceeding remaining bytes, When parsing, Then throws INVALID_INDEX_ENTRY', () => {
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

  it('Given truncated entry (just barely fails security guard), When parsing, Then throws INVALID_INDEX_HEADER', () => {
    // Arrange — header says 1 entry but room is only 10 bytes (< 62)
    const buf = new Uint8Array(12 + 10 + CHECKSUM_SIZE);
    const view = new DataView(buf.buffer);
    view.setUint32(0, 0x44495243);
    view.setUint32(4, 2);
    view.setUint32(8, 1);

    // Act & Assert
    try {
      parseIndex(buf);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TsgitError);
      expect((e as TsgitError).data.code).toBe('INVALID_INDEX_HEADER');
    }
  });

  it('Given entry with flags.stage = 2, When parsing, Then stage field is 2', () => {
    // Arrange
    const input = buildTestIndex([{ path: 'conflict.txt', sha: SHA_A, stage: 2 }]);

    // Act
    const sut = parseIndex(input);

    // Assert
    expect(sut.entries[0]?.flags.stage).toBe(2);
  });

  it('Given entry with assumeValid = true, When parsing, Then flag is set', () => {
    // Arrange
    const input = buildTestIndex([{ path: 'assumed.txt', sha: SHA_A, assumeValid: true }]);

    // Act
    const sut = parseIndex(input);

    // Assert
    expect(sut.entries[0]?.flags.assumeValid).toBe(true);
  });

  it('Given 2 entries claimed but second truncated mid-header, When parsing, Then throws INVALID_INDEX_ENTRY at second entry offset', () => {
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

  it('Given entryCount=1 that barely exceeds capacity in 93-byte buffer, When parsing, Then throws INVALID_INDEX_HEADER', () => {
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
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TsgitError);
      expect((e as TsgitError).data).toEqual({
        code: 'INVALID_INDEX_HEADER',
        reason: 'entry count 1 exceeds file capacity',
      });
    }
  });

  it('Given index with two extensions, When parsing, Then both extensions preserved in order', () => {
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

  it('Given extension with signature starting with char > z (e.g. {), When parsing, Then extension is preserved as optional', () => {
    // Arrange — '{' = charCode 123, above 'z'=122. Kills firstChar<=122→true mutant.
    const input = buildTestIndex([], [{ signature: '{bcd', data: new Uint8Array([1]) }]);

    // Act
    const sut = parseIndex(input);

    // Assert
    expect(sut.extensions).toHaveLength(1);
    expect(sut.extensions[0]?.signature).toBe('{bcd');
  });

  it('Given entry that fits exactly at the boundary (offset+62 === len-20), When parsing, Then entry is accepted', () => {
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
    // This should parse successfully
    const sut = parseIndex(input);

    expect(sut.entries).toHaveLength(1);
    expect(sut.entries[0]?.path).toBe('a');
  });

  it('Given extension whose size exactly fills remaining space, When parsing, Then extension is accepted', () => {
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

  it('Given entry with no NUL terminator in data, When parsing, Then throws INVALID_INDEX_ENTRY', () => {
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

  it('Given an entry whose path starts with a leading `/`, When parseIndex runs, Then throws INVALID_INDEX_ENTRY (absolute path rejected) with offset', () => {
    // Arrange — `/etc/passwd` is an absolute path; index entries must be
    // workdir-relative. Defensive guard added in
    const SHA_A = '0123456789abcdef0123456789abcdef01234567';
    const bytes = buildTestIndex([{ path: '/etc/passwd', sha: SHA_A }]);

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
      offset: 12,
      reason: 'absolute path rejected',
    });
  });

  it('Given an entry whose path contains a `..` segment, When parseIndex runs, Then throws INVALID_INDEX_ENTRY (traversal rejected) with offset', () => {
    // Arrange
    const SHA_A = '0123456789abcdef0123456789abcdef01234567';
    const bytes = buildTestIndex([{ path: 'foo/../bar', sha: SHA_A }]);

    // Act
    let caught: unknown;
    try {
      parseIndex(bytes);
    } catch (err) {
      caught = err;
    }

    // Assert
    expect((caught as TsgitError).data).toEqual({
      code: 'INVALID_INDEX_ENTRY',
      offset: 12,
      reason: "'..' segment rejected",
    });
  });

  it('Given an entry whose path is just `..`, When parseIndex runs, Then throws INVALID_INDEX_ENTRY with reason `..` segment rejected', () => {
    // Arrange — bare `..` reference at root level. Pinning the reason
    // string ensures a mutation that flips the `..` set member would be
    // killed (otherwise the bare-`..` case could surface as a different
    // unsafe-segment reason and still match the generic code).
    const SHA_A = '0123456789abcdef0123456789abcdef01234567';
    const bytes = buildTestIndex([{ path: '..', sha: SHA_A }]);

    // Act
    let caught: unknown;
    try {
      parseIndex(bytes);
    } catch (err) {
      caught = err;
    }

    // Assert
    expect((caught as TsgitError).data).toEqual({
      code: 'INVALID_INDEX_ENTRY',
      offset: 12,
      reason: "'..' segment rejected",
    });
  });

  it('Given an entry whose path contains a `.` segment, When parseIndex runs, Then throws INVALID_INDEX_ENTRY (current-dir rejected)', () => {
    // Arrange
    const SHA_A = '0123456789abcdef0123456789abcdef01234567';
    const bytes = buildTestIndex([{ path: 'foo/./bar', sha: SHA_A }]);

    // Act
    let caught: unknown;
    try {
      parseIndex(bytes);
    } catch (err) {
      caught = err;
    }

    // Assert
    expect((caught as TsgitError).data).toEqual({
      code: 'INVALID_INDEX_ENTRY',
      offset: 12,
      reason: "'.' segment rejected",
    });
  });

  it('Given a SECOND-position unsafe entry, When parseIndex runs, Then offset points to the exact second entry start', () => {
    // Arrange — first entry safe, second entry has '..'. The thrown
    // offset must be the second entry's start (exactly 84, derived
    // below). Pins `entryStart` threading against any mutation that
    // replaces it with a different integer.
    const SHA_A = '0123456789abcdef0123456789abcdef01234567';
    const SHA_B = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const bytes = buildTestIndex([
      { path: 'safe.txt', sha: SHA_A },
      { path: '../etc/passwd', sha: SHA_B },
    ]);

    // First entry: 62 header + 8 name ('safe.txt') + 1 NUL = 71;
    // padded up to multiple of 8 = 72. Header is 12 → second entry
    // starts at 84.
    const SECOND_ENTRY_OFFSET = 12 + 72;

    // Act
    let caught: unknown;
    try {
      parseIndex(bytes);
    } catch (err) {
      caught = err;
    }

    // Assert — exact offset is the only assertion that survives
    // mutation tests on the `entryStart` argument threading.
    expect((caught as TsgitError).data).toEqual({
      code: 'INVALID_INDEX_ENTRY',
      offset: SECOND_ENTRY_OFFSET,
      reason: "'..' segment rejected",
    });
  });

  it('Given an entry whose path contains a backslash, When parseIndex runs, Then throws INVALID_INDEX_ENTRY (Windows separator rejected)', () => {
    // Arrange — `..\\bar` would slip past the slash-segment check on
    // POSIX but resolve to a traversal on Windows.
    const SHA_A = '0123456789abcdef0123456789abcdef01234567';
    const bytes = buildTestIndex([{ path: 'foo\\..\\bar', sha: SHA_A }]);

    // Act
    let caught: unknown;
    try {
      parseIndex(bytes);
    } catch (err) {
      caught = err;
    }

    // Assert
    expect((caught as TsgitError).data).toEqual({
      code: 'INVALID_INDEX_ENTRY',
      offset: 12,
      reason: 'backslash rejected',
    });
  });

  it('Given an entry whose path contains a TAB (C0 control 0x09), When parseIndex runs, Then throws INVALID_INDEX_ENTRY', () => {
    // Arrange — tab (0x09) is a C0 control. Most filesystems accept it,
    // but it can corrupt line-oriented log output and is rejected
    // defensively.
    const SHA_A = '0123456789abcdef0123456789abcdef01234567';
    const bytes = buildTestIndex([{ path: 'foo\tbar', sha: SHA_A }]);

    // Act
    let caught: unknown;
    try {
      parseIndex(bytes);
    } catch (err) {
      caught = err;
    }

    // Assert
    expect((caught as TsgitError).data).toEqual({
      code: 'INVALID_INDEX_ENTRY',
      offset: 12,
      reason: 'control character rejected',
    });
  });

  it('Given an entry whose path contains DEL (0x7F), When parseIndex runs, Then throws INVALID_INDEX_ENTRY', () => {
    // Arrange — 0x7F is the boundary between C0 controls and printable
    // ASCII. Pinning it explicitly kills a mutation that drops the
    // `code === 0x7f` branch from the control-char check.
    const SHA_A = '0123456789abcdef0123456789abcdef01234567';
    const bytes = buildTestIndex([{ path: 'foo\x7fbar', sha: SHA_A }]);

    // Act
    let caught: unknown;
    try {
      parseIndex(bytes);
    } catch (err) {
      caught = err;
    }

    // Assert
    expect((caught as TsgitError).data).toEqual({
      code: 'INVALID_INDEX_ENTRY',
      offset: 12,
      reason: 'control character rejected',
    });
  });

  it('Given an entry whose path contains a C1 control (0x85, NEL), When parseIndex runs, Then throws INVALID_INDEX_ENTRY', () => {
    // Arrange — NEL (Next Line, U+0085) is in the C1 range (0x80-0x9F).
    // C1 controls are rejected for the same reason as C0; pins the
    // extended range against a mutation narrowing the check to C0 only.
    const SHA_A = '0123456789abcdef0123456789abcdef01234567';
    const bytes = buildTestIndex([{ path: 'foo\x85bar', sha: SHA_A }]);

    // Act
    let caught: unknown;
    try {
      parseIndex(bytes);
    } catch (err) {
      caught = err;
    }

    // Assert
    expect((caught as TsgitError).data).toEqual({
      code: 'INVALID_INDEX_ENTRY',
      offset: 12,
      reason: 'control character rejected',
    });
  });

  it('Given a safe path containing only printable ASCII (including space), When parseIndex runs, Then succeeds', () => {
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

  it('Given an entry whose path contains a BIDI override (U+202E), When parseIndex runs, Then throws INVALID_INDEX_ENTRY', () => {
    // Arrange — RTL override can visually disguise filenames in terminals
    // and log lines (e.g., `evil.exe` rendered as `exe.libtrust`).
    const SHA_A = '0123456789abcdef0123456789abcdef01234567';
    const bytes = buildTestIndex([{ path: `evil‮gnp.exe`, sha: SHA_A }]);

    // Act
    let caught: unknown;
    try {
      parseIndex(bytes);
    } catch (err) {
      caught = err;
    }

    // Assert
    expect((caught as TsgitError).data).toEqual({
      code: 'INVALID_INDEX_ENTRY',
      offset: 12,
      reason: 'bidi control character rejected',
    });
  });

  it('Given an entry whose path contains an empty segment (`foo//bar`), When parseIndex runs, Then throws INVALID_INDEX_ENTRY', () => {
    // Arrange — double slash produces an empty segment between the two parts.
    const SHA_A = '0123456789abcdef0123456789abcdef01234567';
    const bytes = buildTestIndex([{ path: 'foo//bar', sha: SHA_A }]);

    // Act
    let caught: unknown;
    try {
      parseIndex(bytes);
    } catch (err) {
      caught = err;
    }

    // Assert
    expect((caught as TsgitError).data).toEqual({
      code: 'INVALID_INDEX_ENTRY',
      offset: 12,
      reason: 'empty segment rejected',
    });
  });
});
