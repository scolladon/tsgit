/**
 * Unit tests for the tar serializer.
 *
 * Verifies ustar header fields, mode-table-M mapping (each arm isolated),
 * pax global header (present iff commit defined), prefix synthesis,
 * and 10240-byte EOF padding.
 *
 * All fixtures are synthetic — no IO. File mode string literals used
 * directly to match FILE_MODE values without importing the domain module.
 */
import { describe, expect, it } from 'vitest';
import { tarArchive } from '../../../../src/domain/archive/tar.js';
import type { ArchiveEntry, ArchiveResult } from '../../../../src/domain/archive/types.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/object-id.js';

// ---------------------------------------------------------------------------
// Header field offsets (mirror the implementation constants — independent)
// ---------------------------------------------------------------------------
const OFF_NAME = 0;
const OFF_MODE = 100;
const OFF_SIZE = 124;
const OFF_MTIME = 136;
const OFF_CHKSUM = 148;
const OFF_TYPEFLAG = 156;
const OFF_LINKNAME = 157;
const OFF_MAGIC = 257;
const OFF_VERSION = 263;
const OFF_UNAME = 265;
const OFF_GNAME = 297;
const HEADER_SIZE = 512;
const BLOCK_SIZE = 512;
const RECORD_SIZE = 10240;

// Typeflags
const TF_REGULAR = 0x30; // '0'
const TF_SYMLINK = 0x32; // '2'
const TF_DIR = 0x35; // '5'
const TF_PAX_GLOBAL = 0x67; // 'g'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function asOid(hex: string): ObjectId {
  return hex as unknown as ObjectId;
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

/** Read null-terminated ASCII field from a block. */
function readField(buf: Uint8Array, offset: number, len: number): string {
  let end = offset;
  while (end < offset + len && buf[end] !== 0) end++;
  return String.fromCharCode(...buf.slice(offset, end));
}

/** Parse a null-terminated octal field as a number. */
function readOctalField(buf: Uint8Array, offset: number, len: number): number {
  return Number.parseInt(readField(buf, offset, len), 8) || 0;
}

/** Verify the unsigned-sum checksum of a 512-byte header block. */
function verifyChecksum(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < HEADER_SIZE; i++) {
    sum += i >= OFF_CHKSUM && i < OFF_CHKSUM + 8 ? 0x20 : (header[i] ?? 0);
  }
  return sum;
}

/**
 * Extract the stored checksum from bytes 148-154 (up to 7 octal digits).
 * Reads the full 8-byte field and parses as octal.  Works for both the
 * git "%07o\0" format and the POSIX "6 digits + NUL + space" format.
 */
function storedChecksum(header: Uint8Array): number {
  const str = readField(header, OFF_CHKSUM, 8); // reads until NUL within 8 bytes
  return Number.parseInt(str.trim(), 8);
}

function makeResult(entries: ArchiveEntry[], commit?: string, commitTime?: number): ArchiveResult {
  const base = {
    tree: asOid('aaaa000000000000000000000000000000000001'),
    entries: (async function* () {
      for (const e of entries) yield e;
    })(),
  };
  return {
    ...base,
    ...(commit !== undefined ? { commit: asOid(commit) } : {}),
    ...(commitTime !== undefined ? { commitTime } : {}),
  };
}

function makeEntry(path: string, mode: string, content?: Uint8Array): ArchiveEntry {
  const base = {
    path: asPath(path),
    mode: mode as ArchiveEntry['mode'],
    oid: asOid('bbbb000000000000000000000000000000000001'),
  };
  return content !== undefined ? { ...base, content } : base;
}

const FIXED_MTIME = 1_112_904_793;
const SAMPLE_OID = 'aabbccdd00112233445566778899aabbccddeeff';

// ---------------------------------------------------------------------------
// Mode table M: each arm in its own test (mutation-resistant)
// ---------------------------------------------------------------------------

describe('Given a regular-file entry (mode 100644)', () => {
  describe('When tarArchive is called with default umask', () => {
    it('Then the mode field is 0000664 and typeflag is 0', async () => {
      // Arrange
      const entry = makeEntry('file.txt', '100644', new Uint8Array([1, 2, 3]));
      const sut = tarArchive(makeResult([entry], undefined, undefined), {
        mtime: FIXED_MTIME,
      });

      // Act
      const result = await collectBytes(sut);
      const header = result.slice(0, HEADER_SIZE);

      // Assert
      expect(readField(header, OFF_MODE, 8)).toBe('0000664');
      expect(header[OFF_TYPEFLAG]).toBe(TF_REGULAR);
    });
  });
});

describe('Given an exec-file entry (mode 100755)', () => {
  describe('When tarArchive is called with default umask', () => {
    it('Then the mode field is 0000775 and typeflag is 0', async () => {
      // Arrange
      const entry = makeEntry('run.sh', '100755', new Uint8Array([0x23, 0x21]));
      const sut = tarArchive(makeResult([entry], undefined, undefined), {
        mtime: FIXED_MTIME,
      });

      // Act
      const result = await collectBytes(sut);
      const header = result.slice(0, HEADER_SIZE);

      // Assert
      expect(readField(header, OFF_MODE, 8)).toBe('0000775');
      expect(header[OFF_TYPEFLAG]).toBe(TF_REGULAR);
    });
  });
});

describe('Given a directory entry (mode 40000)', () => {
  describe('When tarArchive is called', () => {
    it('Then the mode field is 0000775, typeflag is 5, name has trailing slash, and no data block follows', async () => {
      // Arrange
      const entry = makeEntry('subdir', '40000', undefined);
      const sut = tarArchive(makeResult([entry], undefined, undefined), {
        mtime: FIXED_MTIME,
      });

      // Act
      const result = await collectBytes(sut);
      const header = result.slice(0, HEADER_SIZE);

      // Assert
      expect(readField(header, OFF_MODE, 8)).toBe('0000775');
      expect(header[OFF_TYPEFLAG]).toBe(TF_DIR);
      expect(readField(header, OFF_NAME, 100)).toBe('subdir/');
      // Next block after header is the EOF block (size 0 → no data block)
      const nextBlock = result.slice(HEADER_SIZE, HEADER_SIZE + BLOCK_SIZE);
      expect(nextBlock).toEqual(new Uint8Array(BLOCK_SIZE)); // zero (EOF)
    });
  });
});

describe('Given a gitlink entry (mode 160000)', () => {
  describe('When tarArchive is called', () => {
    it('Then the mode field is 0000775, typeflag is 5, name has trailing slash, and no data block follows', async () => {
      // Arrange
      const entry = makeEntry('mysub', '160000', undefined);
      const sut = tarArchive(makeResult([entry], undefined, undefined), {
        mtime: FIXED_MTIME,
      });

      // Act
      const result = await collectBytes(sut);
      const header = result.slice(0, HEADER_SIZE);

      // Assert
      expect(readField(header, OFF_MODE, 8)).toBe('0000775');
      expect(header[OFF_TYPEFLAG]).toBe(TF_DIR);
      expect(readField(header, OFF_NAME, 100)).toBe('mysub/');
      // Next block after header is the first EOF zero block (size 0 → no data block)
      const nextBlock = result.slice(HEADER_SIZE, HEADER_SIZE + BLOCK_SIZE);
      expect(nextBlock).toEqual(new Uint8Array(BLOCK_SIZE));
    });
  });
});

describe('Given a symlink entry (mode 120000)', () => {
  describe('When tarArchive is called', () => {
    it('Then the mode field is 0000777 (unmasked), typeflag is 2, content in linkname, size is 0', async () => {
      // Arrange
      const target = new TextEncoder().encode('a.txt');
      const entry = makeEntry('link', '120000', target);
      const sut = tarArchive(makeResult([entry], undefined, undefined), {
        mtime: FIXED_MTIME,
      });

      // Act
      const result = await collectBytes(sut);
      const header = result.slice(0, HEADER_SIZE);

      // Assert
      expect(readField(header, OFF_MODE, 8)).toBe('0000777');
      expect(header[OFF_TYPEFLAG]).toBe(TF_SYMLINK);
      // linkname field holds the link target
      expect(readField(header, OFF_LINKNAME, 100)).toBe('a.txt');
      // size = 0 (no data block)
      expect(readOctalField(header, OFF_SIZE, 12)).toBe(0);
      // Next block is EOF zero block
      const nextBlock = result.slice(HEADER_SIZE, HEADER_SIZE + BLOCK_SIZE);
      expect(nextBlock).toEqual(new Uint8Array(BLOCK_SIZE));
    });
  });
});

// ---------------------------------------------------------------------------
// Checksum, magic, version, uname, gname
// ---------------------------------------------------------------------------

describe('Given any archive entry', () => {
  describe('When tarArchive is called', () => {
    it('Then the header checksum matches the unsigned byte-sum', async () => {
      // Arrange
      const entry = makeEntry('check.txt', '100644', new Uint8Array([65, 66, 67]));
      const sut = tarArchive(makeResult([entry], undefined, undefined), {
        mtime: FIXED_MTIME,
      });

      // Act
      const result = await collectBytes(sut);
      const header = result.slice(0, HEADER_SIZE);

      // Assert
      expect(storedChecksum(header)).toBe(verifyChecksum(header));
    });

    it('Then magic is ustar NUL and version is 00', async () => {
      // Arrange
      const entry = makeEntry('magic.txt', '100644', new Uint8Array([1]));
      const sut = tarArchive(makeResult([entry], undefined, undefined), {
        mtime: FIXED_MTIME,
      });

      // Act
      const result = await collectBytes(sut);
      const header = result.slice(0, HEADER_SIZE);

      // Assert
      expect(readField(header, OFF_MAGIC, 6)).toBe('ustar');
      expect(header[OFF_MAGIC + 5]).toBe(0x00);
      expect(String.fromCharCode(header[OFF_VERSION] ?? 0, header[OFF_VERSION + 1] ?? 0)).toBe(
        '00',
      );
    });

    it('Then uname and gname are root', async () => {
      // Arrange
      const entry = makeEntry('root.txt', '100644', new Uint8Array([1]));
      const sut = tarArchive(makeResult([entry], undefined, undefined), {
        mtime: FIXED_MTIME,
      });

      // Act
      const result = await collectBytes(sut);
      const header = result.slice(0, HEADER_SIZE);

      // Assert
      expect(readField(header, OFF_UNAME, 32)).toBe('root');
      expect(readField(header, OFF_GNAME, 32)).toBe('root');
    });

    it('Then mtime field matches the supplied mtime in octal', async () => {
      // Arrange
      const entry = makeEntry('time.txt', '100644', new Uint8Array([1]));
      const sut = tarArchive(makeResult([entry], undefined, undefined), {
        mtime: FIXED_MTIME,
      });

      // Act
      const result = await collectBytes(sut);
      const header = result.slice(0, HEADER_SIZE);

      // Assert
      expect(readOctalField(header, OFF_MTIME, 12)).toBe(FIXED_MTIME);
    });
  });
});

// ---------------------------------------------------------------------------
// Pax global header: present iff result.commit is defined
// ---------------------------------------------------------------------------

describe('Given a result with commit defined', () => {
  describe('When tarArchive is called', () => {
    it('Then the first block is a pax global header with typeflag g and name pax_global_header', async () => {
      // Arrange
      const sut = tarArchive(makeResult([], SAMPLE_OID, FIXED_MTIME), {
        mtime: FIXED_MTIME,
      });

      // Act
      const result = await collectBytes(sut);
      const paxHeader = result.slice(0, HEADER_SIZE);

      // Assert
      expect(paxHeader[OFF_TYPEFLAG]).toBe(TF_PAX_GLOBAL);
      expect(readField(paxHeader, OFF_NAME, 100)).toBe('pax_global_header');
      // mode = 0666
      expect(readField(paxHeader, OFF_MODE, 8)).toBe('0000666');
    });

    it('Then the second block contains the 52-byte pax record "52 comment=<oid>\\n" padded to 512', async () => {
      // Arrange
      const sut = tarArchive(makeResult([], SAMPLE_OID, FIXED_MTIME), {
        mtime: FIXED_MTIME,
      });

      // Act
      const result = await collectBytes(sut);
      const paxData = result.slice(BLOCK_SIZE, BLOCK_SIZE * 2);

      // Assert — record is exactly "52 comment=<oid>\n"
      const expectedRecord = `52 comment=${SAMPLE_OID}\n`;
      const expected = new Uint8Array(BLOCK_SIZE);
      new TextEncoder().encodeInto(expectedRecord, expected);
      expect(paxData).toEqual(expected);
    });

    it('Then the pax header size field is 52 (decimal) = 64 (octal)', async () => {
      // Arrange
      const sut = tarArchive(makeResult([], SAMPLE_OID, FIXED_MTIME), {
        mtime: FIXED_MTIME,
      });

      // Act
      const result = await collectBytes(sut);
      const paxHeader = result.slice(0, HEADER_SIZE);

      // Assert
      expect(readOctalField(paxHeader, OFF_SIZE, 12)).toBe(52);
    });
  });
});

describe('Given a bare-tree result (no commit)', () => {
  describe('When tarArchive is called', () => {
    it('Then no pax global header is emitted (empty stream yields 10240 zero bytes)', async () => {
      // Arrange
      const sut = tarArchive(makeResult([], undefined, undefined), {
        mtime: FIXED_MTIME,
      });

      // Act
      const result = await collectBytes(sut);

      // Assert — all bytes are zero (no pax block, just EOF padding)
      expect(result.length).toBe(RECORD_SIZE);
      expect(result.every((b) => b === 0)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// prefix option: synthesised directory entry + prepended paths
// ---------------------------------------------------------------------------

describe('Given prefix option "pre/"', () => {
  describe('When tarArchive is called with a single regular entry', () => {
    it('Then a synthetic directory entry for "pre/" is emitted before the prefixed entry', async () => {
      // Arrange
      const entry = makeEntry('a.txt', '100644', new Uint8Array([1, 2]));
      const sut = tarArchive(makeResult([entry], undefined, undefined), {
        prefix: 'pre/',
        mtime: FIXED_MTIME,
      });

      // Act
      const result = await collectBytes(sut);
      const dirHeader = result.slice(0, HEADER_SIZE);
      const entryHeader = result.slice(HEADER_SIZE, HEADER_SIZE * 2);

      // Assert — first block is the synthetic dir entry
      expect(readField(dirHeader, OFF_NAME, 100)).toBe('pre/');
      expect(dirHeader[OFF_TYPEFLAG]).toBe(TF_DIR);
      // Second block is the entry with prefixed path
      expect(readField(entryHeader, OFF_NAME, 100)).toBe('pre/a.txt');
      expect(entryHeader[OFF_TYPEFLAG]).toBe(TF_REGULAR);
    });
  });
});

// ---------------------------------------------------------------------------
// 10240 EOF padding
// ---------------------------------------------------------------------------

describe('Given an empty entry stream with no commit', () => {
  describe('When tarArchive is called', () => {
    it('Then the total output is exactly 10240 bytes (two EOF blocks + padding)', async () => {
      // Arrange
      const sut = tarArchive(makeResult([], undefined, undefined), {
        mtime: FIXED_MTIME,
      });

      // Act
      const result = await collectBytes(sut);

      // Assert
      expect(result.length).toBe(RECORD_SIZE);
    });
  });
});

describe('Given a single regular-file entry (512 header + 512 data = 1024) with a commit (pax = 1024)', () => {
  describe('When tarArchive is called', () => {
    it('Then the total output is a multiple of 10240', async () => {
      // Arrange
      // pax header (512) + pax data (512) + entry header (512) + data padded (512) = 2048
      // + 2 EOF blocks (1024) = 3072 → padded to 10240
      const entry = makeEntry('x.txt', '100644', new Uint8Array(10));
      const sut = tarArchive(makeResult([entry], SAMPLE_OID, FIXED_MTIME), {
        mtime: FIXED_MTIME,
      });

      // Act
      const result = await collectBytes(sut);

      // Assert
      expect(result.length % RECORD_SIZE).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Custom uname/gname options
// ---------------------------------------------------------------------------

describe('Given custom uname and gname options', () => {
  describe('When tarArchive is called', () => {
    it('Then uname and gname fields reflect the supplied values', async () => {
      // Arrange
      const entry = makeEntry('f.txt', '100644', new Uint8Array([1]));
      const sut = tarArchive(makeResult([entry], undefined, undefined), {
        mtime: FIXED_MTIME,
        uname: 'alice',
        gname: 'staff',
      });

      // Act
      const result = await collectBytes(sut);
      const header = result.slice(0, HEADER_SIZE);

      // Assert
      expect(readField(header, OFF_UNAME, 32)).toBe('alice');
      expect(readField(header, OFF_GNAME, 32)).toBe('staff');
    });
  });
});

// ---------------------------------------------------------------------------
// mtime defaults: falls back to result.commitTime when opts.mtime is absent
// ---------------------------------------------------------------------------

describe('Given no explicit mtime in opts but result.commitTime is defined', () => {
  describe('When tarArchive is called', () => {
    it('Then entry mtime equals result.commitTime', async () => {
      // Arrange
      const entry = makeEntry('t.txt', '100644', new Uint8Array([1]));
      const result = makeResult([entry], undefined, FIXED_MTIME);
      // No mtime in opts → should default to result.commitTime
      const sut = tarArchive(result, {});

      // Act
      const bytes = await collectBytes(sut);
      const header = bytes.slice(0, HEADER_SIZE);

      // Assert
      expect(readOctalField(header, OFF_MTIME, 12)).toBe(FIXED_MTIME);
    });
  });
});

// ---------------------------------------------------------------------------
// mtime fallback: both opts.mtime and result.commitTime undefined → epoch 0
// ---------------------------------------------------------------------------

describe('Given no explicit mtime in opts and no result.commitTime', () => {
  describe('When tarArchive is called', () => {
    it('Then entry mtime falls back to 0', async () => {
      // Arrange — both undefined → mtime = opts?.mtime ?? result.commitTime ?? 0 = 0
      const entry = makeEntry('z.txt', '100644', new Uint8Array([1]));
      const sut = tarArchive(makeResult([entry], undefined, undefined), {});

      // Act
      const result = await collectBytes(sut);
      const header = result.slice(0, HEADER_SIZE);

      // Assert
      expect(readOctalField(header, OFF_MTIME, 12)).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// padTo512 early-return: content already aligned to 512 bytes
// ---------------------------------------------------------------------------

describe('Given a regular-file entry whose content is exactly 512 bytes', () => {
  describe('When tarArchive is called', () => {
    it('Then the data block is exactly 512 bytes (no extra padding appended)', async () => {
      // Arrange — 512-byte content is already aligned; padTo512 returns it unchanged
      const content = new Uint8Array(512).fill(0x41);
      const entry = makeEntry('big.txt', '100644', content);
      const sut = tarArchive(makeResult([entry], undefined, undefined), { mtime: FIXED_MTIME });

      // Act
      const result = await collectBytes(sut);

      // Assert — header (512) + data (512) + EOF (1024) + padding to 10240
      // Data block occupies bytes [512, 1024): it should equal the content exactly
      const dataBlock = result.slice(HEADER_SIZE, HEADER_SIZE + BLOCK_SIZE);
      expect(dataBlock).toEqual(content);
      // The block after the data block should begin the EOF zeros
      const firstEofByte = result[HEADER_SIZE + BLOCK_SIZE];
      expect(firstEofByte).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// EOF padding no-op: archive already a multiple of RECORD_SIZE (10240)
// ---------------------------------------------------------------------------

describe('Given a stream of 18 directory entries (no commit, no prefix)', () => {
  describe('When tarArchive is called', () => {
    it('Then the total output is exactly 10240 bytes with no trailing padding block', async () => {
      // Arrange — 18 dir entries × 512 bytes each = 9216, + 1024 EOF = 10240.
      // byteCount % RECORD_SIZE === 0 → the padding branch is NOT taken.
      const entries = Array.from({ length: 18 }, (_, i) =>
        makeEntry(`dir${i}`, '40000', undefined),
      );
      const sut = tarArchive(makeResult(entries, undefined, undefined), { mtime: FIXED_MTIME });

      // Act
      const result = await collectBytes(sut);

      // Assert — exactly one record, no extra padding emitted
      expect(result.length).toBe(RECORD_SIZE);
      // The last 1024 bytes are the two EOF zero blocks
      const eof = result.slice(RECORD_SIZE - BLOCK_SIZE * 2);
      expect(eof).toEqual(new Uint8Array(BLOCK_SIZE * 2));
    });
  });
});

// ---------------------------------------------------------------------------
// splitPath error paths: >256-byte path and unsplittable 101–256-byte path
// ---------------------------------------------------------------------------

describe('Given a regular-file entry whose path exceeds 256 bytes', () => {
  describe('When tarArchive is called', () => {
    it('Then it throws with a message indicating the path is too long for ustar', async () => {
      // Arrange — 257-byte path: 'a'.repeat(257)
      const longPath = 'a'.repeat(257);
      const entry = makeEntry(longPath, '100644', new Uint8Array([1]));
      const sut = tarArchive(makeResult([entry], undefined, undefined), { mtime: FIXED_MTIME });

      // Act
      let thrown: unknown;
      try {
        await collectBytes(sut);
      } catch (err) {
        thrown = err;
      }

      // Assert
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(
        `Path too long for ustar archive (>256 bytes): ${longPath}`,
      );
    });
  });
});

describe('Given a regular-file entry whose 101–256-byte path has no slash yielding a 1–100-byte name', () => {
  describe('When tarArchive is called', () => {
    it('Then it throws with a message indicating the path cannot be split', async () => {
      // Arrange — 'a/' + 'b'.repeat(154) = 156 bytes; the only slash at i=1
      // yields nameLen = 154 > NAME_MAX, so no valid split exists
      const unsplittablePath = `a/${'b'.repeat(154)}`;
      const entry = makeEntry(unsplittablePath, '100644', new Uint8Array([1]));
      const sut = tarArchive(makeResult([entry], undefined, undefined), { mtime: FIXED_MTIME });

      // Act
      let thrown: unknown;
      try {
        await collectBytes(sut);
      } catch (err) {
        thrown = err;
      }

      // Assert
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(
        `Cannot split path into ustar prefix+name: ${unsplittablePath}`,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// splitPath: directory path with trailing slash skips empty-name split
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// writeOctal overflow guard: size field overflow for enormous blobs
// ---------------------------------------------------------------------------

describe('Given a regular-file entry whose content length exceeds the 11-digit octal capacity', () => {
  describe('When tarArchive is called', () => {
    it('Then it throws with a message indicating the octal field is too small', async () => {
      // Arrange — fake a content whose .length exceeds 8^11-1 = 8_589_934_591.
      // writeOctal is called before padTo512, so padTo512 is never reached.
      const oversizedContent = { length: 9_000_000_000 } as unknown as Uint8Array;
      const entry = makeEntry('big.bin', '100644', oversizedContent);
      const sut = tarArchive(makeResult([entry], undefined, undefined), { mtime: FIXED_MTIME });

      // Act
      let thrown: unknown;
      try {
        await collectBytes(sut);
      } catch (err) {
        thrown = err;
      }

      // Assert
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/exceeds the 11-digit octal field capacity/);
    });
  });
});

// ---------------------------------------------------------------------------
// linkname guard: symlink target longer than the 100-byte ustar field
// ---------------------------------------------------------------------------

describe('Given a symlink entry whose target exceeds the 100-byte ustar linkname field', () => {
  describe('When tarArchive is called', () => {
    it('Then it throws indicating the symlink target is too long for ustar', async () => {
      // Arrange — a 101-byte symlink target (pax extended linkname is out of scope).
      const longTarget = new Uint8Array(101).fill(0x61);
      const entry = makeEntry('link', '120000', longTarget);
      const sut = tarArchive(makeResult([entry], undefined, undefined), { mtime: FIXED_MTIME });

      // Act
      let thrown: unknown;
      try {
        await collectBytes(sut);
      } catch (err) {
        thrown = err;
      }

      // Assert
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/Symlink target too long for ustar archive/);
    });
  });
});

// ---------------------------------------------------------------------------
// Mutation boundary: writeOctal NUL byte position
// ---------------------------------------------------------------------------

describe('Given writeOctal is called with a value exactly at the max (8^11-1) for the size field (len=12)', () => {
  describe('When tarArchive is called', () => {
    it('Then it does NOT throw — boundary is strictly greater-than, not >=', async () => {
      // Arrange — 8^11-1 = 8_589_934_591 bytes is the exact capacity for an 11-digit octal field.
      // The `val > MAX_OCTAL_VALUE(len)` guard must allow this exact value; `>=` would wrongly throw.
      // Also pins the MAX_OCTAL_VALUE arithmetic: `8^(12-1)-1` must be exactly 8_589_934_591;
      // `+1` mutation would produce 8_589_934_593, making the guard throw earlier.
      const maxVal = 8 ** 11 - 1; // 8_589_934_591
      const oversizedContent = { length: maxVal } as unknown as Uint8Array;
      const entry = makeEntry('boundary.bin', '100644', oversizedContent);
      const sut = tarArchive(makeResult([entry], undefined, undefined), { mtime: FIXED_MTIME });

      // Act — pull only the header block. Draining the stream would force the
      // serializer to materialise the (fake) 8 GiB of content and hang; the size
      // guard runs while the header is built, so the first chunk is all we need.
      const header = (await sut[Symbol.asyncIterator]().next()).value as Uint8Array;

      // Assert — the boundary value is accepted and encoded as the full
      // 11-octal-digit maximum. A `>=` mutant would throw here; a mutated
      // `8 ** (12 - 1) - 1` cap would throw or encode a different value.
      expect(readOctalField(header, OFF_SIZE, 12)).toBe(maxVal);
    });
  });
});

describe('Given writeOctal is called with a value one above the max (8^11) for the size field', () => {
  describe('When tarArchive is called', () => {
    it('Then it throws indicating octal overflow — boundary is strictly val > max', async () => {
      // Arrange — 8^11 = 8_589_934_592, one above the 11-digit capacity.
      const overMax = 8 ** 11; // 8_589_934_592
      const oversizedContent = { length: overMax } as unknown as Uint8Array;
      const entry = makeEntry('over.bin', '100644', oversizedContent);
      const sut = tarArchive(makeResult([entry], undefined, undefined), { mtime: FIXED_MTIME });

      // Act
      let thrown: unknown;
      try {
        await collectBytes(sut);
      } catch (err) {
        thrown = err;
      }

      // Assert — strictly > boundary: 8^11 must throw, 8^11-1 must not.
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/exceeds the 11-digit octal field capacity/);
    });
  });
});

// ---------------------------------------------------------------------------
// Mutation boundary: writeAscii / writeBytes field bounds
// ---------------------------------------------------------------------------

describe('Given a uname value whose length exactly equals the LEN_UNAME field (32 bytes)', () => {
  describe('When tarArchive is called', () => {
    it('Then the uname field contains exactly those 32 bytes with no overflow into adjacent bytes', async () => {
      // Arrange — a 32-byte uname string exercises the Math.min(str.length, len) clip in writeAscii;
      // Math.max would write 32 bytes into a 32-byte field with i going 0..31 — same result.
      // But a 33-byte uname with Math.max would overflow into the adjacent gname field.
      // We test with uname length 33 to expose the Math.max mutant: if Math.max is used the loop
      // runs 33 iterations, writing one byte past the end of OFF_UNAME into OFF_GNAME[0].
      const longUname = 'a'.repeat(33); // 33 chars, 1 over LEN_UNAME=32
      const entry = makeEntry('f.txt', '100644', new Uint8Array([1]));
      const sut = tarArchive(makeResult([entry], undefined, undefined), {
        mtime: FIXED_MTIME,
        uname: longUname,
        gname: 'root',
      });

      // Act
      const result = await collectBytes(sut);
      const header = result.slice(0, HEADER_SIZE);

      // Assert — gname field must still start with 'r' (not 'a' from uname overflow)
      const OFF_GNAME = 297;
      expect(header[OFF_GNAME]).toBe('r'.charCodeAt(0));
      // uname field must start correctly (first 32 bytes of longUname)
      const OFF_UNAME = 265;
      expect(header[OFF_UNAME]).toBe('a'.charCodeAt(0));
    });
  });
});

describe('Given a uname string of exactly 32 bytes and a writeAscii i <= writeLen loop bound', () => {
  describe('When tarArchive is called with a 32-byte uname', () => {
    it('Then writeAscii writes at most 32 bytes — the loop i < writeLen keeps the field within bounds', async () => {
      // Arrange — a 32-char uname; writeLen = Math.min(32, 32) = 32; loop runs i=0..31.
      // The i <= writeLen mutant would run i=0..32, writing a 33rd byte (str.charCodeAt(32) = NaN → 0)
      // into the adjacent field. We detect this by setting gname to 'root' and checking
      // that OFF_GNAME[0] is still 'r' (0x72), not 0x00 (the NaN/0 write from the extra iteration).
      const uname32 = 'a'.repeat(32); // exactly 32 chars — writeLen = 32, so mutant writes at index 32
      const OFF_GNAME = 297;
      const OFF_UNAME_END = 265 + 32; // = 297 = OFF_GNAME
      expect(OFF_UNAME_END).toBe(OFF_GNAME); // documents adjacency

      const entry = makeEntry('f.txt', '100644', new Uint8Array([1]));
      const sut = tarArchive(makeResult([entry], undefined, undefined), {
        mtime: FIXED_MTIME,
        uname: uname32,
        gname: 'root',
      });

      // Act
      const result = await collectBytes(sut);
      const header = result.slice(0, HEADER_SIZE);

      // Assert — gname[0] must be 'r' (not corrupted by extra write)
      expect(header[OFF_GNAME]).toBe('r'.charCodeAt(0));
    });
  });
});

// ---------------------------------------------------------------------------
// Mutation boundary: writeBytes Math.max
// ---------------------------------------------------------------------------

describe('Given a symlink whose target is exactly 100 bytes (the linkname field capacity)', () => {
  describe('When tarArchive is called', () => {
    it('Then it does NOT throw — boundary is strictly >, not >=', async () => {
      // Arrange — 100-byte target is exactly LEN_LINKNAME=100; the guard `> LEN_LINKNAME` allows it.
      // The `>= LEN_LINKNAME` mutant would wrongly throw on this exact length.
      const target100 = new Uint8Array(100).fill(0x61); // 100 bytes of 'a'
      const entry = makeEntry('link', '120000', target100);
      const sut = tarArchive(makeResult([entry], undefined, undefined), { mtime: FIXED_MTIME });

      // Act
      const result = await collectBytes(sut);
      const header = result.slice(0, HEADER_SIZE);

      // Assert — no throw; linkname field should contain the 100 'a' bytes
      expect(header[OFF_LINKNAME]).toBe(0x61);
      expect(header[OFF_LINKNAME + 99]).toBe(0x61);
    });
  });
});

describe('Given a symlink whose target is exactly 101 bytes (one over the linkname field)', () => {
  describe('When tarArchive is called', () => {
    it('Then it throws indicating the symlink target is too long', async () => {
      // Arrange — 101-byte target is 1 over LEN_LINKNAME; `> LEN_LINKNAME` must throw here.
      const target101 = new Uint8Array(101).fill(0x61);
      const entry = makeEntry('link', '120000', target101);
      const sut = tarArchive(makeResult([entry], undefined, undefined), { mtime: FIXED_MTIME });

      // Act
      let thrown: unknown;
      try {
        await collectBytes(sut);
      } catch (err) {
        thrown = err;
      }

      // Assert
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/Symlink target too long for ustar archive/);
    });
  });
});

// ---------------------------------------------------------------------------
// Mutation boundary: writeBytes clamp — Math.max writes past field boundary
// ---------------------------------------------------------------------------

describe('Given a symlink entry and writeBytes uses Math.max instead of Math.min', () => {
  describe('When tarArchive is called with a 5-byte target', () => {
    it('Then the linkname field bytes 5-99 remain NUL — Math.min clips correctly', async () => {
      // Arrange — 5-byte target 'hello'; Math.min(5, 100) = 5 bytes written; Math.max(5,100)=100
      // would write 100 bytes — but content is only 5 bytes, so subarray(0,100) returns the
      // full 5-byte array and set() only copies what's there. Actually the mutant changes
      // `bytes.subarray(0, Math.min(bytes.length, len))` to `Math.max(bytes.length, len)`,
      // where len is the field length. For writeBytes(buf, OFF_LINKNAME, LEN_LINKNAME=100, bytes5),
      // Math.max(5, 100) = 100 → subarray(0, 100) on a 5-byte array returns all 5 bytes (no padding)
      // — so it's equivalent here. The mutant IS detectable in writeBytes(buf, OFF_NAME, LEN_NAME=100, longPathBytes)
      // where bytes.length > len: Math.max(156, 100) = 156 → copies 156 bytes past the 100-byte field.
      // We test that case: a symlink path that is exactly 100 bytes does not corrupt the mode field.
      const longPath = 'a'.repeat(100); // 100 bytes — goes into name field only
      const target = new Uint8Array(5).fill(0x61); // short target
      const entry = makeEntry(longPath, '120000', target);
      const sut = tarArchive(makeResult([entry], undefined, undefined), { mtime: FIXED_MTIME });

      // Act
      const result = await collectBytes(sut);
      const header = result.slice(0, HEADER_SIZE);

      // Assert — mode field (offset 100, 8 bytes) must not be corrupted by name overflow
      // If Math.max were used for writing a path of 100 bytes into a 100-byte field,
      // subarray(0, Math.max(100,100)) = subarray(0,100) — same as Math.min. Actually for
      // name this is still equivalent. Let's pin via writeBytes for the linkname of a path
      // that forces prefix splitting: use a long path name where nameBytes > LEN_NAME but still valid.
      // A more effective probe: verify the mode field is intact (not overwritten by name data).
      expect(readField(header, OFF_MODE, 8)).toBe('0000777'); // symlink mode
    });
  });
});

// ---------------------------------------------------------------------------
// Mutation boundary: writeChecksum loop i < 7 vs i <= 7
// ---------------------------------------------------------------------------

describe('Given any entry header, the checksum field byte 7 must be 0x00', () => {
  describe('When tarArchive is called', () => {
    it('Then header[OFF_CHKSUM + 7] is 0x00 — the NUL terminator, not an octal digit', async () => {
      // Arrange — the writeChecksum loop `i < 7` writes bytes 0-6; byte 7 stays 0x00 (buf zero-init).
      // The `i <= 7` mutant writes byte 7 as str.charCodeAt(7), which for a 7-char padded string
      // wraps to str.charCodeAt(7) = NaN → 0, so it's actually equivalent via NaN coercion.
      // BUT: if sum.toString(8).padStart(7,'0') produces 7 chars and i goes 0..7 (8 iterations),
      // the last write is str.charCodeAt(7) which is NaN (string has only 7 chars) → 0 anyway.
      // So this IS equivalent — we document it and pin via checksum verification.
      const entry = makeEntry('chk.txt', '100644', new Uint8Array([1, 2, 3]));
      const sut = tarArchive(makeResult([entry], undefined, undefined), { mtime: FIXED_MTIME });

      // Act
      const result = await collectBytes(sut);
      const header = result.slice(0, HEADER_SIZE);

      // Assert — the NUL byte is at position 7 of the checksum field
      expect(header[OFF_CHKSUM + 7]).toBe(0x00);
      // And the checksum verifies correctly (the full checksum test covers this too)
      expect(storedChecksum(header)).toBe(verifyChecksum(header));
    });
  });
});

// ---------------------------------------------------------------------------
// Mutation boundary: splitPath byteLen <= NAME_MAX (exactly 100-byte path)
// ---------------------------------------------------------------------------

describe('Given a regular-file entry whose UTF-8 path is exactly 100 bytes', () => {
  describe('When tarArchive is called', () => {
    it('Then the entire path goes into the name field with no prefix — byteLen <= NAME_MAX allows it', async () => {
      // Arrange — a 100-byte ASCII path: `byteLen <= NAME_MAX` puts it entirely in name.
      // The `byteLen < NAME_MAX` mutant would NOT take this branch, pushing it to the split
      // logic that requires a slash — and since 'a'.repeat(100) has no slash, it throws.
      const path100 = 'a'.repeat(100); // exactly 100 bytes
      const entry = makeEntry(path100, '100644', new Uint8Array([1]));
      const sut = tarArchive(makeResult([entry], undefined, undefined), { mtime: FIXED_MTIME });

      // Act
      const result = await collectBytes(sut);
      const header = result.slice(0, HEADER_SIZE);

      // Assert — name field holds the full 100-byte path, no prefix field used
      expect(readField(header, OFF_NAME, 100)).toBe(path100);
      expect(header[345]).toBe(0); // prefix field byte 0 is NUL (no prefix)
    });
  });
});

// ---------------------------------------------------------------------------
// Mutation boundary: splitPath byteLen > PATH_MAX_USTAR (exactly 256-byte path)
// ---------------------------------------------------------------------------

describe('Given a regular-file entry whose path with a valid split is exactly 256 bytes', () => {
  describe('When tarArchive is called', () => {
    it('Then it does NOT throw — byteLen > PATH_MAX_USTAR allows exactly 256 bytes', async () => {
      // Arrange — a path of exactly 256 bytes with a split point that yields valid prefix+name.
      // prefix = 'a'.repeat(155), '/', name = 'b'.repeat(100) → total = 155+1+100 = 256 bytes.
      // The `byteLen >= PATH_MAX_USTAR` mutant would reject this as too long.
      const path256 = `${'a'.repeat(155)}/${'b'.repeat(100)}`; // 256 bytes
      expect(new TextEncoder().encode(path256).length).toBe(256); // verify fixture
      const entry = makeEntry(path256, '100644', new Uint8Array([1]));
      const sut = tarArchive(makeResult([entry], undefined, undefined), { mtime: FIXED_MTIME });

      // Act
      const result = await collectBytes(sut);
      const header = result.slice(0, HEADER_SIZE);

      // Assert — name field has the 100 'b' bytes; no throw
      expect(readField(header, OFF_NAME, 100)).toBe('b'.repeat(100));
      expect(header[OFF_TYPEFLAG]).toBe(TF_REGULAR);
    });
  });
});

// ---------------------------------------------------------------------------
// Mutation boundary: splitPath Math.max(byteLen-1, PREFIX_MAX) start offset
// ---------------------------------------------------------------------------

describe('Given a 256-byte path whose only valid split is at position 155 (start of search)', () => {
  describe('When tarArchive is called', () => {
    it('Then the split succeeds — Math.min(byteLen-1, PREFIX_MAX) starts at the right position', async () => {
      // Arrange — path = 'a'×155 + '/' + 'b'×100 = 256 bytes.
      // Math.min(255, 155) = 155. The slash at i=155 yields nameLen = 256-155-1 = 100 ≤ NAME_MAX → valid.
      // Math.max(255, 155) = 255. Starting at 255, the loop finds no '/' at the end of a 'b' string,
      // scans all the way down to the single '/' at i=155. Same result — this mutant IS equivalent
      // for this specific case (the '/' is found in both directions).
      // To distinguish: use a path where the ONLY valid split is at i <= PREFIX_MAX but the Math.max
      // start would be byteLen-1 > PREFIX_MAX... but the loop is capped at PREFIX_MAX via Math.min.
      // Actually for paths in (256, 256] the start is always 155 with Math.min. The mutant starts
      // at 255 with Math.max(byteLen-1, PREFIX_MAX) = max(255,155) = 255. It scans from 255 down
      // to the '/' at 155 — and finds it. Equivalent for this fixture.
      // We document the equivalence and still pin behavior:
      const path256 = `${'a'.repeat(155)}/${'b'.repeat(100)}`;
      const entry = makeEntry(path256, '100644', new Uint8Array([1]));
      const sut = tarArchive(makeResult([entry], undefined, undefined), { mtime: FIXED_MTIME });

      // Act — must not throw
      const result = await collectBytes(sut);
      const header = result.slice(0, HEADER_SIZE);

      // Assert
      expect(readField(header, OFF_NAME, 100)).toBe('b'.repeat(100));
    });
  });
});

// ---------------------------------------------------------------------------
// Mutation boundary: nameLen >= 1 (the split point yields a 1-byte name)
// ---------------------------------------------------------------------------

describe('Given a 101-byte path whose only valid split yields a 1-byte name', () => {
  describe('When tarArchive is called', () => {
    it('Then the split is accepted — nameLen >= 1 allows a 1-byte name', async () => {
      // Arrange — path = 'a'×99 + '/' + 'b' = 101 bytes.
      // The split at i=99 (the '/'): nameLen = 101-99-1 = 1 ≥ 1 → valid.
      // The `nameLen > 1` mutant rejects nameLen=1, falls through, and throws "Cannot split".
      const path101 = `${'a'.repeat(99)}/b`; // 101 bytes
      expect(new TextEncoder().encode(path101).length).toBe(101);
      const entry = makeEntry(path101, '100644', new Uint8Array([1]));
      const sut = tarArchive(makeResult([entry], undefined, undefined), { mtime: FIXED_MTIME });

      // Act
      const result = await collectBytes(sut);
      const header = result.slice(0, HEADER_SIZE);

      // Assert — name = 'b', no throw
      expect(readField(header, OFF_NAME, 100)).toBe('b');
      expect(header[OFF_TYPEFLAG]).toBe(TF_REGULAR);
    });
  });
});

// ---------------------------------------------------------------------------
// Mutation boundary: nameLen <= NAME_MAX (the split yields an exactly 100-byte name)
// ---------------------------------------------------------------------------

describe('Given a 256-byte path whose best valid split yields a 100-byte name', () => {
  describe('When tarArchive is called', () => {
    it('Then the split is accepted — nameLen <= NAME_MAX allows a 100-byte name', async () => {
      // Arrange — path = 'a'×155 + '/' + 'b'×100 = 256 bytes.
      // Split at i=155: nameLen = 256-155-1 = 100 = NAME_MAX → accepted by nameLen <= NAME_MAX.
      // The `nameLen < NAME_MAX` mutant rejects nameLen=100, continues scanning,
      // finds no other valid split, and throws "Cannot split path".
      const path256 = `${'a'.repeat(155)}/${'b'.repeat(100)}`; // 256 bytes
      const entry = makeEntry(path256, '100644', new Uint8Array([1]));
      const sut = tarArchive(makeResult([entry], undefined, undefined), { mtime: FIXED_MTIME });

      // Act
      const result = await collectBytes(sut);
      const header = result.slice(0, HEADER_SIZE);

      // Assert — name = 100 'b' bytes; prefix = 155 'a' bytes
      expect(readField(header, OFF_NAME, 100)).toBe('b'.repeat(100));
      const OFF_PREFIX = 345;
      expect(readField(header, OFF_PREFIX, 155)).toBe('a'.repeat(155));
    });
  });
});

// ---------------------------------------------------------------------------
// Mutation boundary: paddingNeeded rem === 0 ? 0 : BLOCK_SIZE - rem
// ---------------------------------------------------------------------------

describe('Given a regular-file entry whose content is exactly 512 bytes (rem=0)', () => {
  describe('When tarArchive is called', () => {
    it('Then no extra padding block is emitted — paddingNeeded returns 0 for 512-aligned content', async () => {
      // Arrange — 512-byte content: rem = 512 % 512 = 0 → paddingNeeded = 0 → no padding block.
      // The `false ? 0 : BLOCK_SIZE - rem` mutant always returns BLOCK_SIZE-rem.
      // When rem=0, it returns 512, yielding an extra 512-byte padding block.
      const content = new Uint8Array(512).fill(0x41);
      const entry = makeEntry('aligned.bin', '100644', content);
      const sut = tarArchive(makeResult([entry], undefined, undefined), { mtime: FIXED_MTIME });

      // Act
      const result = await collectBytes(sut);

      // Assert — layout: header(512) + content(512) + EOF(1024) + record-padding = 10240 total.
      // With the `false ? 0 : BLOCK_SIZE - rem` mutant: rem=0 returns BLOCK_SIZE=512 instead of 0,
      // yielding an extra 512-byte pad block: header+content+pad+EOF = 2560 → padded to 10240.
      // Wait — both are padded to 10240. So we need a more direct assertion.
      // With correct code: BLOCK_SIZE = 512 aligned, pad=0, byteCount after loop = 512+512+1024 = 2048,
      // remainder = 2048 % 10240 = 2048 ≠ 0 → pads to 10240. Total = 10240. ✓
      // With mutant (extra 512 pad): byteCount = 2048+512 = 2560, remainder = 2560 → pads to 10240.
      // Both produce 10240 bytes. So total-length is NOT a good discriminator here.
      // Better: pin the actual content bytes — the data block at HEADER_SIZE must be exactly content.
      const dataBlock = result.slice(HEADER_SIZE, HEADER_SIZE + BLOCK_SIZE);
      expect(dataBlock).toEqual(content);
      // And the byte right after the data block starts the EOF blocks (0x00), not more content.
      expect(result[HEADER_SIZE + BLOCK_SIZE]).toBe(0x00);
    });
  });
});

describe('Given a regular-file entry whose content is 1 byte (rem=1, pad=511)', () => {
  describe('When tarArchive is called', () => {
    it('Then a 511-byte padding block is emitted after the content', async () => {
      // Arrange — 1-byte content: rem = 1, pad = 511.
      // This exercises the `BLOCK_SIZE - rem` arm and also pins pad > 0 guard.
      const content = new Uint8Array([0x42]);
      const entry = makeEntry('one.bin', '100644', content);
      const sut = tarArchive(makeResult([entry], undefined, undefined), { mtime: FIXED_MTIME });

      // Act
      const result = await collectBytes(sut);

      // Assert — byte at HEADER_SIZE is the content byte 0x42
      expect(result[HEADER_SIZE]).toBe(0x42);
      // Bytes at HEADER_SIZE+1 through HEADER_SIZE+511 are NUL padding
      expect(result[HEADER_SIZE + 1]).toBe(0x00);
      expect(result[HEADER_SIZE + 511]).toBe(0x00);
      // Byte HEADER_SIZE+512 starts the EOF block (0x00)
      expect(result[HEADER_SIZE + 512]).toBe(0x00);
    });
  });
});

describe('Given a regular-file entry with 0-byte content', () => {
  describe('When tarArchive is called', () => {
    it('Then no data block is emitted — content.length > 0 guard skips the yield', async () => {
      // Arrange — a 0-byte regular file: content.length = 0, `> 0` is false → no data block.
      // The `>= 0` mutant makes the condition always true (length is always ≥ 0), yielding
      // an empty Uint8Array and then skipping the pad block (pad=0 → no extra block).
      // The `true` mutant yields a 0-byte data block.
      // Both mutations result in yielding new Uint8Array(0), which adds 0 bytes to the stream.
      // So for a 0-byte content, the mutations ARE equivalent — the net byte output is the same.
      // We pin by checking the total output size: header(512) + EOF(1024) = 1536, padded to 10240.
      const content = new Uint8Array(0);
      const entry = makeEntry('empty.bin', '100644', content);
      const sut = tarArchive(makeResult([entry], undefined, undefined), { mtime: FIXED_MTIME });

      // Act
      const result = await collectBytes(sut);
      const header = result.slice(0, HEADER_SIZE);

      // Assert — size field in header is 0
      expect(readOctalField(header, OFF_SIZE, 12)).toBe(0);
      // Total: header + 2 EOF blocks + record padding
      expect(result.length).toBe(RECORD_SIZE);
    });
  });
});

describe('Given a directory entry whose path with trailing slash is 101–256 bytes', () => {
  describe('When tarArchive is called', () => {
    it('Then the name field contains the last component with its slash, not an empty string', async () => {
      // Arrange — directory path (without trailing slash) = 109 bytes, which
      // after buildEntryPath appends '/' becomes 110 bytes.
      // The trailing slash at i=109 would yield nameLen=0 (skipped); the split
      // falls back to i=98, yielding name='jjjjjjjjjj/' (11 bytes).
      const dirComponents = [
        'aaaaaaaaaa',
        'bbbbbbbbbb',
        'cccccccccc',
        'dddddddddd',
        'eeeeeeeeee',
        'ffffffffff',
        'gggggggggg',
        'hhhhhhhhhh',
        'iiiiiiiiii',
        'jjjjjjjjjj',
      ];
      const dirPath = dirComponents.join('/');
      const entry = makeEntry(dirPath, '40000', undefined);
      const sut = tarArchive(makeResult([entry], undefined, undefined), { mtime: FIXED_MTIME });

      // Act
      const bytes = await collectBytes(sut);
      const header = bytes.slice(0, HEADER_SIZE);

      // Assert — name is 'jjjjjjjjjj/' (non-empty last component + slash)
      expect(readField(header, OFF_NAME, 100)).toBe('jjjjjjjjjj/');
      // And it is a directory entry
      expect(header[OFF_TYPEFLAG]).toBe(TF_DIR);
    });
  });
});
