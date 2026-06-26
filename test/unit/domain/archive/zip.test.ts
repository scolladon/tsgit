/**
 * Unit tests for the zip serializer.
 *
 * Verifies local + central header bytes (matrix Z), method selection per arm
 * (each arm isolated), version-made-by + external-attr per kind, internal-attr
 * text/binary, trailing-slash dir + gitlink, prefix synthesis, EOCD commit
 * comment, and DOS-time tzOffsetMinutes variants.
 *
 * All fixtures are synthetic — no IO. deflateRaw is a deterministic stub.
 */
import { describe, expect, it } from 'vitest';
import type { ArchiveEntry, ArchiveResult } from '../../../../src/domain/archive/types.js';
import { type ZipDeps, zipArchive } from '../../../../src/domain/archive/zip.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/object-id.js';

// ---------------------------------------------------------------------------
// Stub deflateRaw implementations
// ---------------------------------------------------------------------------

/** Identity: returns content unchanged — compressed.length === content.length → method 0. */
const identityDeflateRaw: ZipDeps['deflateRaw'] = async (data: Uint8Array) => new Uint8Array(data);

/**
 * Shrink: returns content minus last byte (when ≥2 bytes) — compressed.length < content.length → method 8.
 * For ≤1 byte input falls back to identity (still works because those entries use method 0 by size).
 */
const shrinkDeflateRaw: ZipDeps['deflateRaw'] = async (data: Uint8Array) => {
  if (data.length >= 2) return data.slice(0, data.length - 1);
  return new Uint8Array(data);
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asOid(hex: string): ObjectId {
  return hex.padEnd(40, '0') as unknown as ObjectId;
}

function asPath(p: string): FilePath {
  return p as unknown as FilePath;
}

async function collectBytes(gen: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of gen) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const chunk of chunks) {
    out.set(chunk, off);
    off += chunk.length;
  }
  return out;
}

/** Assert an element exists at the given index and return it. */
function mustGet<T>(arr: ReadonlyArray<T>, idx = 0): T {
  const v = arr[idx];
  if (v === undefined) throw new Error(`array[${idx}] is undefined`);
  return v;
}

function readU16LE(buf: Uint8Array, off: number): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint16(off, true);
}

function readU32LE(buf: Uint8Array, off: number): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(off, true);
}

// ---------------------------------------------------------------------------
// Minimal zip parser — LOCAL headers, CENTRAL dir, EOCD
// ---------------------------------------------------------------------------

// Signatures
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

interface ParsedLocalEntry {
  readonly versionNeeded: number;
  readonly flags: number;
  readonly method: number;
  readonly modTime: number;
  readonly modDate: number;
  readonly crc: number;
  readonly csize: number;
  readonly usize: number;
  readonly name: string;
  readonly extra: Uint8Array;
  readonly data: Uint8Array;
  readonly headerOffset: number;
}

interface ParsedCentralEntry {
  readonly versionMadeBy: number;
  readonly versionNeeded: number;
  readonly flags: number;
  readonly method: number;
  readonly modTime: number;
  readonly modDate: number;
  readonly crc: number;
  readonly csize: number;
  readonly usize: number;
  readonly internalAttr: number;
  readonly externalAttr: number;
  readonly localOffset: number;
  readonly name: string;
  readonly extra: Uint8Array;
}

interface ParsedEocd {
  readonly disk: number;
  readonly startDisk: number;
  readonly entriesOnDisk: number;
  readonly totalEntries: number;
  readonly cdSize: number;
  readonly cdOffset: number;
  readonly comment: string;
}

interface ParsedZip {
  readonly locals: ParsedLocalEntry[];
  readonly centrals: ParsedCentralEntry[];
  readonly eocd: ParsedEocd;
}

function parseZip(buf: Uint8Array): ParsedZip {
  const locals: ParsedLocalEntry[] = [];
  const centrals: ParsedCentralEntry[] = [];
  let eocd!: ParsedEocd;

  let pos = 0;
  // Parse all local file headers
  while (pos < buf.length) {
    const sig = readU32LE(buf, pos);
    if (sig === SIG_LOCAL) {
      const headerOffset = pos;
      const versionNeeded = readU16LE(buf, pos + 4);
      const flags = readU16LE(buf, pos + 6);
      const method = readU16LE(buf, pos + 8);
      const modTime = readU16LE(buf, pos + 10);
      const modDate = readU16LE(buf, pos + 12);
      const crc = readU32LE(buf, pos + 14);
      const csize = readU32LE(buf, pos + 18);
      const usize = readU32LE(buf, pos + 22);
      const nameLen = readU16LE(buf, pos + 26);
      const extraLen = readU16LE(buf, pos + 28);
      const nameBytes = buf.slice(pos + 30, pos + 30 + nameLen);
      const name = new TextDecoder().decode(nameBytes);
      const extra = buf.slice(pos + 30 + nameLen, pos + 30 + nameLen + extraLen);
      const dataStart = pos + 30 + nameLen + extraLen;
      const data = buf.slice(dataStart, dataStart + csize);
      locals.push({
        versionNeeded,
        flags,
        method,
        modTime,
        modDate,
        crc,
        csize,
        usize,
        name,
        extra,
        data,
        headerOffset,
      });
      pos = dataStart + csize;
    } else if (sig === SIG_CENTRAL || sig === SIG_EOCD) {
      break;
    } else {
      pos++;
    }
  }
  // Parse central directory
  while (pos < buf.length) {
    const sig = readU32LE(buf, pos);
    if (sig !== SIG_CENTRAL) break;
    const versionMadeBy = readU16LE(buf, pos + 4);
    const versionNeeded = readU16LE(buf, pos + 6);
    const flags = readU16LE(buf, pos + 8);
    const method = readU16LE(buf, pos + 10);
    const modTime = readU16LE(buf, pos + 12);
    const modDate = readU16LE(buf, pos + 14);
    const crc = readU32LE(buf, pos + 16);
    const csize = readU32LE(buf, pos + 20);
    const usize = readU32LE(buf, pos + 24);
    const nameLen = readU16LE(buf, pos + 28);
    const extraLen = readU16LE(buf, pos + 30);
    // commentLen at pos+32 = 0
    // disk at pos+34 = 0
    const internalAttr = readU16LE(buf, pos + 36);
    const externalAttr = readU32LE(buf, pos + 38);
    const localOffset = readU32LE(buf, pos + 42);
    const nameBytes = buf.slice(pos + 46, pos + 46 + nameLen);
    const name = new TextDecoder().decode(nameBytes);
    const extra = buf.slice(pos + 46 + nameLen, pos + 46 + nameLen + extraLen);
    centrals.push({
      versionMadeBy,
      versionNeeded,
      flags,
      method,
      modTime,
      modDate,
      crc,
      csize,
      usize,
      internalAttr,
      externalAttr,
      localOffset,
      name,
      extra,
    });
    pos += 46 + nameLen + extraLen;
  }
  // Parse EOCD
  if (readU32LE(buf, pos) === SIG_EOCD) {
    const disk = readU16LE(buf, pos + 4);
    const startDisk = readU16LE(buf, pos + 6);
    const entriesOnDisk = readU16LE(buf, pos + 8);
    const totalEntries = readU16LE(buf, pos + 10);
    const cdSize = readU32LE(buf, pos + 12);
    const cdOffset = readU32LE(buf, pos + 16);
    const commentLen = readU16LE(buf, pos + 20);
    const commentBytes = buf.slice(pos + 22, pos + 22 + commentLen);
    const comment = new TextDecoder().decode(commentBytes);
    eocd = { disk, startDisk, entriesOnDisk, totalEntries, cdSize, cdOffset, comment };
  }
  return { locals, centrals, eocd };
}

// UT extra field constants (independent of zip.ts)
const UT_EXTRA_ID = 0x5455;
const UT_EXTRA_DATA_SIZE = 5;
const UT_EXTRA_FLAG_MOD_TIME = 0x01;

/** Parse the UT extra field from 9 extra bytes. */
function parseUtExtra(extra: Uint8Array): {
  id: number;
  size: number;
  flag: number;
  mtime: number;
} {
  const id = readU16LE(extra, 0);
  const size = readU16LE(extra, 2);
  const flag = new DataView(extra.buffer, extra.byteOffset).getUint8(4);
  const mtime = readU32LE(extra, 5);
  return { id, size, flag, mtime };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_MTIME = 1_112_904_793; // 2005-04-07T20:13:13Z
const FAKE_OID = asOid('abc');

function makeResult(entries: ArchiveEntry[], commit?: string): ArchiveResult {
  return {
    tree: asOid('deadbeef'),
    ...(commit !== undefined ? { commit: asOid(commit), commitTime: FIXED_MTIME } : {}),
    ...(commit !== undefined ? { commitTime: FIXED_MTIME } : {}),
    entries: (async function* () {
      yield* entries;
    })(),
  };
}

function regularEntry(
  name: string,
  content: Uint8Array,
  mode: '100644' | '100755' = '100644',
): ArchiveEntry {
  return { path: asPath(name), mode, oid: FAKE_OID, content };
}

function symlinkEntry(name: string, target: string): ArchiveEntry {
  return {
    path: asPath(name),
    mode: '120000',
    oid: FAKE_OID,
    content: new TextEncoder().encode(target),
  };
}

function dirEntry(name: string): ArchiveEntry {
  return { path: asPath(name), mode: '40000', oid: FAKE_OID };
}

function gitlinkEntry(name: string): ArchiveEntry {
  return { path: asPath(name), mode: '160000', oid: FAKE_OID };
}

// ---------------------------------------------------------------------------
// Local header: fixed fields
// ---------------------------------------------------------------------------

describe('Given a single regular entry', () => {
  describe('When zipArchive is serialized with identity deflateRaw', () => {
    it('Then the local header has sig PK\\x03\\x04, version-needed 10, flags 0x0000', async () => {
      // Arrange
      const content = new Uint8Array([0x68, 0x69]); // "hi", 2 bytes, no NUL
      const result = makeResult([regularEntry('a.txt', content)]);
      const sut = zipArchive(result, { deflateRaw: identityDeflateRaw });

      // Act
      const bytes = await collectBytes(sut);
      const parsed = parseZip(bytes);

      // Assert
      expect(parsed.locals).toHaveLength(1);
      const local = mustGet(parsed.locals);
      // sig: PK\x03\x04
      expect(buf32Le(bytes, 0)).toBe(SIG_LOCAL);
      expect(local.versionNeeded).toBe(10);
      expect(local.flags).toBe(0x0000);
    });
  });
});

function buf32Le(buf: Uint8Array, off: number): number {
  return readU32LE(buf, off);
}

describe('Given a single regular text entry', () => {
  describe('When zipArchive is serialized with identity deflateRaw (no compression)', () => {
    it('Then local header carries correct CRC, csize=usize, namelen, extralen=9, and UT extra', async () => {
      // Arrange
      const content = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]); // "hello"
      const result = makeResult([regularEntry('a.txt', content)]);
      const sut = zipArchive(result, { deflateRaw: identityDeflateRaw }, { mtime: FIXED_MTIME });

      // Act
      const bytes = await collectBytes(sut);
      const parsed = parseZip(bytes);
      const local = mustGet(parsed.locals);

      // Assert sizes and name
      expect(local.usize).toBe(5);
      expect(local.csize).toBe(5); // identity → method 0, csize == usize
      expect(local.name).toBe('a.txt');
      expect(local.extra).toHaveLength(9);

      // Assert UT extra bytes
      const ut = parseUtExtra(local.extra);
      expect(ut.id).toBe(UT_EXTRA_ID);
      expect(ut.size).toBe(UT_EXTRA_DATA_SIZE);
      expect(ut.flag).toBe(UT_EXTRA_FLAG_MOD_TIME);
      expect(ut.mtime).toBe(FIXED_MTIME);
    });
  });
});

// ---------------------------------------------------------------------------
// Method selection: each arm isolated (mutation-resistant)
// ---------------------------------------------------------------------------

describe('Given a multi-byte regular entry and shrink deflateRaw', () => {
  describe('When zipArchive is serialized (compressed is smaller)', () => {
    it('Then method is 8 (deflate) and csize < usize', async () => {
      // Arrange
      const content = new Uint8Array(10).fill(0x41); // 10 bytes of 'A'
      const result = makeResult([regularEntry('big.txt', content)]);
      const sut = zipArchive(result, { deflateRaw: shrinkDeflateRaw });

      // Act
      const bytes = await collectBytes(sut);
      const parsed = parseZip(bytes);
      const local = mustGet(parsed.locals);
      const central = mustGet(parsed.centrals);

      // Assert — method 8, compressed bytes stored
      expect(local.method).toBe(8);
      expect(local.usize).toBe(10);
      expect(local.csize).toBe(9); // shrinkDeflateRaw removes 1 byte
      expect(local.csize).toBeLessThan(local.usize);
      expect(central.method).toBe(8);
    });
  });
});

describe('Given a single-byte regular entry and shrink deflateRaw', () => {
  describe('When zipArchive is serialized (compressed is NOT smaller)', () => {
    it('Then method is 0 (store) and csize == usize', async () => {
      // Arrange — single byte: shrinkDeflateRaw returns it unchanged (identity for ≤1 byte)
      const content = new Uint8Array([0x41]);
      const result = makeResult([regularEntry('one.txt', content)]);
      const sut = zipArchive(result, { deflateRaw: shrinkDeflateRaw });

      // Act
      const bytes = await collectBytes(sut);
      const parsed = parseZip(bytes);
      const local = mustGet(parsed.locals);
      const central = mustGet(parsed.centrals);

      // Assert — method 0, csize == usize
      expect(local.method).toBe(0);
      expect(local.csize).toBe(local.usize);
      expect(central.method).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Central directory: version-made-by + external-attr per kind
// ---------------------------------------------------------------------------

describe('Given a regular text entry (100644)', () => {
  describe('When central directory is emitted', () => {
    it('Then version-made-by is 0x0000 and external-attr is 0x00000000', async () => {
      // Arrange
      const content = new Uint8Array([0x74, 0x65, 0x78, 0x74]); // "text"
      const result = makeResult([regularEntry('a.txt', content, '100644')]);
      const sut = zipArchive(result, { deflateRaw: identityDeflateRaw });

      // Act
      const bytes = await collectBytes(sut);
      const central = mustGet(parseZip(bytes).centrals);

      // Assert
      expect(central.versionMadeBy).toBe(0x0000);
      expect(central.externalAttr).toBe(0x00000000);
    });
  });
});

describe('Given an exec entry (100755)', () => {
  describe('When central directory is emitted', () => {
    it('Then version-made-by is 0x0317 (unix) and external-attr is 0x81ed0000', async () => {
      // Arrange
      const content = new TextEncoder().encode('#!/bin/sh\n');
      const result = makeResult([regularEntry('run.sh', content, '100755')]);
      const sut = zipArchive(result, { deflateRaw: identityDeflateRaw });

      // Act
      const bytes = await collectBytes(sut);
      const central = mustGet(parseZip(bytes).centrals);

      // Assert
      expect(central.versionMadeBy).toBe(0x0317);
      expect(central.externalAttr).toBe(0x81ed0000);
    });
  });
});

describe('Given a symlink entry (120000)', () => {
  describe('When central directory is emitted', () => {
    it('Then version-made-by is 0x0317 (unix) and external-attr is 0xa1ff0000', async () => {
      // Arrange
      const result = makeResult([symlinkEntry('link', 'target.txt')]);
      const sut = zipArchive(result, { deflateRaw: identityDeflateRaw });

      // Act
      const bytes = await collectBytes(sut);
      const central = mustGet(parseZip(bytes).centrals);

      // Assert
      expect(central.versionMadeBy).toBe(0x0317);
      expect(central.externalAttr).toBe(0xa1ff0000);
    });
  });
});

describe('Given a directory entry (40000)', () => {
  describe('When central directory is emitted', () => {
    it('Then version-made-by is 0x0000 and external-attr is 0x00000010', async () => {
      // Arrange
      const result = makeResult([dirEntry('mydir')]);
      const sut = zipArchive(result, { deflateRaw: identityDeflateRaw });

      // Act
      const bytes = await collectBytes(sut);
      const central = mustGet(parseZip(bytes).centrals);

      // Assert
      expect(central.versionMadeBy).toBe(0x0000);
      expect(central.externalAttr).toBe(0x00000010);
    });
  });
});

describe('Given a gitlink entry (160000)', () => {
  describe('When central directory is emitted', () => {
    it('Then version-made-by is 0x0000 and external-attr is 0x00000010 (same as dir)', async () => {
      // Arrange
      const result = makeResult([gitlinkEntry('mysub')]);
      const sut = zipArchive(result, { deflateRaw: identityDeflateRaw });

      // Act
      const bytes = await collectBytes(sut);
      const central = mustGet(parseZip(bytes).centrals);

      // Assert
      expect(central.versionMadeBy).toBe(0x0000);
      expect(central.externalAttr).toBe(0x00000010);
    });
  });
});

// ---------------------------------------------------------------------------
// Internal attr: text bit
// ---------------------------------------------------------------------------

describe('Given a regular entry with no NUL bytes (text)', () => {
  describe('When central directory is emitted', () => {
    it('Then internal-attr is 0x0001 (text)', async () => {
      // Arrange
      const content = new TextEncoder().encode('hello\n'); // no NUL
      const result = makeResult([regularEntry('a.txt', content)]);
      const sut = zipArchive(result, { deflateRaw: identityDeflateRaw });

      // Act
      const bytes = await collectBytes(sut);
      const central = mustGet(parseZip(bytes).centrals);

      // Assert
      expect(central.internalAttr).toBe(0x0001);
    });
  });
});

describe('Given a regular entry with a NUL byte (binary)', () => {
  describe('When central directory is emitted', () => {
    it('Then internal-attr is 0x0000 (binary)', async () => {
      // Arrange
      const content = new Uint8Array([0x00, 0x01, 0x02]); // has NUL
      const result = makeResult([regularEntry('data.bin', content)]);
      const sut = zipArchive(result, { deflateRaw: identityDeflateRaw });

      // Act
      const bytes = await collectBytes(sut);
      const central = mustGet(parseZip(bytes).centrals);

      // Assert
      expect(central.internalAttr).toBe(0x0000);
    });
  });
});

describe('Given an exec entry with no NUL bytes', () => {
  describe('When central directory is emitted', () => {
    it('Then internal-attr is 0x0001 (text)', async () => {
      // Arrange
      const content = new TextEncoder().encode('#!/bin/sh\n');
      const result = makeResult([regularEntry('run.sh', content, '100755')]);
      const sut = zipArchive(result, { deflateRaw: identityDeflateRaw });

      // Act
      const bytes = await collectBytes(sut);
      const central = mustGet(parseZip(bytes).centrals);

      // Assert
      expect(central.internalAttr).toBe(0x0001);
    });
  });
});

describe('Given an exec entry with a NUL byte (binary exec)', () => {
  describe('When central directory is emitted', () => {
    it('Then internal-attr is 0x0000 (binary)', async () => {
      // Arrange
      const content = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00]); // ELF magic + NUL
      const result = makeResult([regularEntry('prog', content, '100755')]);
      const sut = zipArchive(result, { deflateRaw: identityDeflateRaw });

      // Act
      const bytes = await collectBytes(sut);
      const central = mustGet(parseZip(bytes).centrals);

      // Assert
      expect(central.internalAttr).toBe(0x0000);
    });
  });
});

describe('Given a symlink entry', () => {
  describe('When central directory is emitted', () => {
    it('Then internal-attr is 0x0001 (always text for symlinks)', async () => {
      // Arrange
      const result = makeResult([symlinkEntry('link', 'some/target')]);
      const sut = zipArchive(result, { deflateRaw: identityDeflateRaw });

      // Act
      const bytes = await collectBytes(sut);
      const central = mustGet(parseZip(bytes).centrals);

      // Assert
      expect(central.internalAttr).toBe(0x0001);
    });
  });
});

describe('Given a directory entry (40000)', () => {
  describe('When central directory is emitted', () => {
    it('Then internal-attr is 0x0000 (always binary for dirs)', async () => {
      // Arrange
      const result = makeResult([dirEntry('mydir')]);
      const sut = zipArchive(result, { deflateRaw: identityDeflateRaw });

      // Act
      const bytes = await collectBytes(sut);
      const central = mustGet(parseZip(bytes).centrals);

      // Assert
      expect(central.internalAttr).toBe(0x0000);
    });
  });
});

describe('Given a gitlink entry (160000)', () => {
  describe('When central directory is emitted', () => {
    it('Then internal-attr is 0x0000 (always binary for gitlinks)', async () => {
      // Arrange
      const result = makeResult([gitlinkEntry('mysub')]);
      const sut = zipArchive(result, { deflateRaw: identityDeflateRaw });

      // Act
      const bytes = await collectBytes(sut);
      const central = mustGet(parseZip(bytes).centrals);

      // Assert
      expect(central.internalAttr).toBe(0x0000);
    });
  });
});

// ---------------------------------------------------------------------------
// Trailing-slash names: dir and gitlink
// ---------------------------------------------------------------------------

describe('Given a directory entry with path "nested"', () => {
  describe('When zipArchive is serialized', () => {
    it('Then the local and central dir entry names carry a trailing slash "nested/"', async () => {
      // Arrange
      const result = makeResult([dirEntry('nested')]);
      const sut = zipArchive(result, { deflateRaw: identityDeflateRaw });

      // Act
      const bytes = await collectBytes(sut);
      const parsed = parseZip(bytes);

      // Assert
      expect(mustGet(parsed.locals).name).toBe('nested/');
      expect(mustGet(parsed.centrals).name).toBe('nested/');
    });
  });
});

describe('Given a gitlink entry with path "mysub"', () => {
  describe('When zipArchive is serialized', () => {
    it('Then the local and central dir entry names carry a trailing slash "mysub/"', async () => {
      // Arrange
      const result = makeResult([gitlinkEntry('mysub')]);
      const sut = zipArchive(result, { deflateRaw: identityDeflateRaw });

      // Act
      const bytes = await collectBytes(sut);
      const parsed = parseZip(bytes);

      // Assert
      expect(mustGet(parsed.locals).name).toBe('mysub/');
      expect(mustGet(parsed.centrals).name).toBe('mysub/');
    });
  });
});

describe('Given dir/gitlink entries', () => {
  describe('When zipArchive is serialized', () => {
    it('Then dir entry has size 0, csize 0, crc 0, and method 0', async () => {
      // Arrange
      const result = makeResult([dirEntry('mydir')]);
      const sut = zipArchive(result, { deflateRaw: identityDeflateRaw });

      // Act
      const bytes = await collectBytes(sut);
      const parsed = parseZip(bytes);
      const local = mustGet(parsed.locals);

      // Assert
      expect(local.method).toBe(0);
      expect(local.csize).toBe(0);
      expect(local.usize).toBe(0);
      expect(local.crc).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// EOCD: comment present iff commit defined
// ---------------------------------------------------------------------------

describe('Given a result with a commit oid', () => {
  describe('When zipArchive EOCD is emitted', () => {
    it('Then the EOCD comment equals the 40-hex commit oid', async () => {
      // Arrange
      const commitHex = 'aabbccddeeff001122334455667788990011223344';
      const result = makeResult([], commitHex);
      const sut = zipArchive(result, { deflateRaw: identityDeflateRaw });

      // Act
      const bytes = await collectBytes(sut);
      const eocd = parseZip(bytes).eocd;

      // Assert
      expect(eocd.comment).toBe(asOid(commitHex));
    });
  });
});

describe('Given a bare-tree result (no commit)', () => {
  describe('When zipArchive EOCD is emitted', () => {
    it('Then the EOCD comment is empty', async () => {
      // Arrange
      const result = makeResult([]);
      const sut = zipArchive(result, { deflateRaw: identityDeflateRaw });

      // Act
      const bytes = await collectBytes(sut);
      const eocd = parseZip(bytes).eocd;

      // Assert
      expect(eocd.comment).toBe('');
    });
  });
});

// ---------------------------------------------------------------------------
// EOCD: entry counts
// ---------------------------------------------------------------------------

describe('Given two entries', () => {
  describe('When EOCD is emitted', () => {
    it('Then EOCD totalEntries = 2 and entriesOnDisk = 2', async () => {
      // Arrange
      const result = makeResult([
        regularEntry('a.txt', new TextEncoder().encode('a')),
        regularEntry('b.txt', new TextEncoder().encode('b')),
      ]);
      const sut = zipArchive(result, { deflateRaw: identityDeflateRaw });

      // Act
      const bytes = await collectBytes(sut);
      const eocd = parseZip(bytes).eocd;

      // Assert
      expect(eocd.totalEntries).toBe(2);
      expect(eocd.entriesOnDisk).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// DOS time: tzOffsetMinutes variants
// ---------------------------------------------------------------------------

describe('Given mtime=1112904793 and tzOffsetMinutes=0 (UTC)', () => {
  describe('When DOS time fields are emitted', () => {
    it('Then modTime=0xa1a6 and modDate=0x3287 (pinned against git in UTC)', async () => {
      // Arrange — epoch 1112904793 = 2005-04-07T20:13:13Z
      const result = makeResult([regularEntry('a.txt', new TextEncoder().encode('x'))]);
      const sut = zipArchive(
        result,
        { deflateRaw: identityDeflateRaw },
        { mtime: FIXED_MTIME, tzOffsetMinutes: 0 },
      );

      // Act
      const bytes = await collectBytes(sut);
      const local = mustGet(parseZip(bytes).locals);

      // Assert — pinned from faithfulness matrix Z (UTC)
      expect(local.modTime).toBe(0xa1a6);
      expect(local.modDate).toBe(0x3287);
    });
  });
});

describe('Given mtime=1112904793 and tzOffsetMinutes=120 (+0200)', () => {
  describe('When DOS time fields are emitted', () => {
    it('Then modTime=0xb1a6 and modDate=0x3287 (pinned against git in +0200)', async () => {
      // Arrange — same epoch, but breakdowns in +0200 local
      const result = makeResult([regularEntry('a.txt', new TextEncoder().encode('x'))]);
      const sut = zipArchive(
        result,
        { deflateRaw: identityDeflateRaw },
        { mtime: FIXED_MTIME, tzOffsetMinutes: 120 },
      );

      // Act
      const bytes = await collectBytes(sut);
      const local = mustGet(parseZip(bytes).locals);

      // Assert — pinned from faithfulness matrix Z (+0200)
      expect(local.modTime).toBe(0xb1a6);
      expect(local.modDate).toBe(0x3287);
    });
  });
});

// ---------------------------------------------------------------------------
// UT extra: byte-identical in local and central
// ---------------------------------------------------------------------------

describe('Given a single entry', () => {
  describe('When local and central UT extra fields are compared', () => {
    it('Then the 9-byte UT extra is byte-identical in both', async () => {
      // Arrange
      const result = makeResult([regularEntry('a.txt', new TextEncoder().encode('hi'))]);
      const sut = zipArchive(result, { deflateRaw: identityDeflateRaw }, { mtime: FIXED_MTIME });

      // Act
      const bytes = await collectBytes(sut);
      const parsed = parseZip(bytes);
      const localExtra = mustGet(parsed.locals).extra;
      const centralExtra = mustGet(parsed.centrals).extra;

      // Assert
      expect(localExtra).toHaveLength(9);
      expect(centralExtra).toHaveLength(9);
      expect(localExtra).toEqual(centralExtra);
    });
  });
});

// ---------------------------------------------------------------------------
// prefix synthesis
// ---------------------------------------------------------------------------

describe('Given prefix="pre/" and a regular entry "a.txt"', () => {
  describe('When zipArchive is serialized', () => {
    it('Then a leading "pre/" directory entry is emitted, and "a.txt" becomes "pre/a.txt"', async () => {
      // Arrange
      const result = makeResult([regularEntry('a.txt', new TextEncoder().encode('hello'))]);
      const sut = zipArchive(result, { deflateRaw: identityDeflateRaw }, { prefix: 'pre/' });

      // Act
      const bytes = await collectBytes(sut);
      const parsed = parseZip(bytes);

      // Assert — two entries: prefix dir + file
      expect(parsed.locals).toHaveLength(2);
      expect(mustGet(parsed.locals).name).toBe('pre/');
      expect(mustGet(parsed.locals, 1).name).toBe('pre/a.txt');
      expect(mustGet(parsed.centrals).name).toBe('pre/');
      expect(mustGet(parsed.centrals, 1).name).toBe('pre/a.txt');
    });
  });
});

describe('Given prefix="pre/" and a directory entry "nested"', () => {
  describe('When zipArchive is serialized', () => {
    it('Then the dir entry becomes "pre/nested/" (prefix + trailing slash)', async () => {
      // Arrange
      const result = makeResult([dirEntry('nested')]);
      const sut = zipArchive(result, { deflateRaw: identityDeflateRaw }, { prefix: 'pre/' });

      // Act
      const bytes = await collectBytes(sut);
      const parsed = parseZip(bytes);

      // Assert — prefix dir + nested dir
      expect(mustGet(parsed.locals).name).toBe('pre/');
      expect(mustGet(parsed.locals, 1).name).toBe('pre/nested/');
    });
  });
});

// ---------------------------------------------------------------------------
// Central dir version-needed always 10
// ---------------------------------------------------------------------------

describe('Given any entry', () => {
  describe('When central directory is emitted', () => {
    it('Then version-needed is 10 in both local and central headers', async () => {
      // Arrange
      const result = makeResult([regularEntry('a.txt', new TextEncoder().encode('hi'))]);
      const sut = zipArchive(result, { deflateRaw: identityDeflateRaw });

      // Act
      const bytes = await collectBytes(sut);
      const parsed = parseZip(bytes);

      // Assert
      expect(mustGet(parsed.locals).versionNeeded).toBe(10);
      expect(mustGet(parsed.centrals).versionNeeded).toBe(10);
    });
  });
});

// ---------------------------------------------------------------------------
// local-header offset in central directory
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// compressEntry: content absent on a non-dir entry → treated as empty blob
// ---------------------------------------------------------------------------

describe('Given a regular-file entry with no content field', () => {
  describe('When zipArchive is called', () => {
    it('Then it emits a stored (method 0) entry with size 0 and CRC 0', async () => {
      // Arrange — content undefined on a non-dir mode; compressEntry falls back to empty Uint8Array
      const entry: ArchiveEntry = {
        path: 'empty.txt' as unknown as FilePath,
        mode: '100644',
        oid: FAKE_OID,
        // content intentionally absent
      };
      const result = makeResult([entry]);
      const sut = zipArchive(result, { deflateRaw: identityDeflateRaw });

      // Act
      const bytes = await collectBytes(sut);
      const parsed = parseZip(bytes);

      // Assert — empty body → method 0, csize 0, usize 0, crc 0
      const local = mustGet(parsed.locals);
      expect(local.method).toBe(0);
      expect(local.csize).toBe(0);
      expect(local.usize).toBe(0);
      expect(local.crc).toBe(0);
    });
  });
});

describe('Given two entries, the second entry follows the first', () => {
  describe('When central directory is emitted', () => {
    it('Then the second central entry carries the correct local-header offset', async () => {
      // Arrange
      const c1 = new TextEncoder().encode('file1');
      const c2 = new TextEncoder().encode('second');
      const result = makeResult([regularEntry('first.txt', c1), regularEntry('second.txt', c2)]);
      const sut = zipArchive(result, { deflateRaw: identityDeflateRaw });

      // Act
      const bytes = await collectBytes(sut);
      const parsed = parseZip(bytes);

      // Assert — second central's localOffset matches second local's headerOffset
      expect(mustGet(parsed.centrals).localOffset).toBe(mustGet(parsed.locals).headerOffset);
      expect(mustGet(parsed.centrals, 1).localOffset).toBe(mustGet(parsed.locals, 1).headerOffset);
    });
  });
});
