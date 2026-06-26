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
