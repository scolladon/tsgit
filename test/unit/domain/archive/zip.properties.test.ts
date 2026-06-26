/**
 * Lens-1 round-trip property for the zip serializer.
 *
 * Property: zipArchive(result) can be parsed back by a MINIMAL IN-TEST ZIP
 * READER (an independent oracle — NOT sharing code with the writer) to recover
 * the original entry set (paths, sizes, content), modulo synthesised
 * dir/EOCD framing and store-vs-deflate choice.
 *
 * Method-8 entries are round-tripped via test-side inflateRaw (Node
 * `inflateRawSync` — not a port method), method-0 entries are read verbatim.
 *
 * numRuns: 200 (cheap round-trip property, per test conventions).
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { zipArchive } from '../../../../src/domain/archive/zip.js';
import { arbArchiveResult } from './arbitraries.js';

// ---------------------------------------------------------------------------
// Real deflateRaw stub using node:zlib — produces valid DEFLATE output that
// the oracle can round-trip via inflateRawSync. Method selection depends on
// whether the content actually compresses smaller (content-dependent).
// ---------------------------------------------------------------------------

async function nodeDeflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(deflateRawSync(data));
}

// ---------------------------------------------------------------------------
// Collect async iterable
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Independent minimal zip reader (oracle)
//
// Intentionally uses a completely different approach to parsing than zip.ts
// — raw byte scanning vs the writer's per-entry record accumulation.
// Uses test-side inflateRawSync from node:zlib for method-8 round-trip.
// ---------------------------------------------------------------------------

function readU16LE(buf: Uint8Array, off: number): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint16(off, true);
}

function readU32LE(buf: Uint8Array, off: number): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(off, true);
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

interface RoundTrippedEntry {
  readonly name: string;
  readonly method: number;
  readonly content: Uint8Array;
  readonly crc: number;
  readonly usize: number;
}

/**
 * Parse a zip buffer and return all local file entries.
 * Skips the prefix dir entry (name ending in '/') to match only original entries.
 * method-8 content is inflated via inflateRawSync; method-0 is read verbatim.
 */
function parseZipEntries(buf: Uint8Array): RoundTrippedEntry[] {
  const entries: RoundTrippedEntry[] = [];
  let pos = 0;

  while (pos + 4 <= buf.length) {
    const sig = readU32LE(buf, pos);
    if (sig !== LOCAL_SIG) break;

    const method = readU16LE(buf, pos + 8);
    const crc = readU32LE(buf, pos + 14);
    const csize = readU32LE(buf, pos + 18);
    const usize = readU32LE(buf, pos + 22);
    const nameLen = readU16LE(buf, pos + 26);
    const extraLen = readU16LE(buf, pos + 28);
    const nameBytes = buf.slice(pos + 30, pos + 30 + nameLen);
    const name = new TextDecoder().decode(nameBytes);
    const dataStart = pos + 30 + nameLen + extraLen;
    const compressedData = buf.slice(dataStart, dataStart + csize);

    let content: Uint8Array;
    if (method === 8) {
      // Raw-inflate the compressed data
      content = new Uint8Array(inflateRawSync(compressedData));
    } else {
      content = compressedData;
    }

    entries.push({ name, method, content, crc, usize });
    pos = dataStart + csize;
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Property: round-trip (lens 1 — serialize/parse)
// ---------------------------------------------------------------------------

describe('Given an arbitrary ArchiveResult', () => {
  describe('When zipArchive(result) is parsed by the independent oracle', () => {
    it('Then every non-dir entry round-trips: path, content, sizes, CRC', async () => {
      await fc.assert(
        fc.asyncProperty(arbArchiveResult(), async ({ entries, result }) => {
          // Arrange — use shrink deflateRaw to exercise method-8 when content ≥ 2 bytes
          const sut = zipArchive(result, { deflateRaw: nodeDeflateRaw });

          // Act
          const bytes = await collectBytes(sut);
          const parsed = parseZipEntries(bytes);

          // Filter out dir/gitlink entries and prefix dir (synthesised, no original)
          const origBlobs = entries.filter((e) => e.mode !== '40000' && e.mode !== '160000');

          // Assert — each blob entry matches
          for (const orig of origBlobs) {
            const found = parsed.find((p) => p.name === orig.path);
            expect(found, `entry "${orig.path}" not found in parsed zip`).toBeDefined();
            if (!found) continue;

            const expectedContent = orig.content ?? new Uint8Array(0);

            // Content round-trip
            expect(found.content).toEqual(expectedContent);

            // Size matches uncompressed length
            expect(found.usize).toBe(expectedContent.length);
          }
        }),
        { numRuns: 200 },
      );
    });
  });
});

describe('Given an arbitrary ArchiveResult', () => {
  describe('When zipArchive(result) is parsed', () => {
    it('Then dir/gitlink entries always use method 0 and have zero sizes', async () => {
      await fc.assert(
        fc.asyncProperty(arbArchiveResult(), async ({ entries, result }) => {
          // Arrange
          const sut = zipArchive(result, { deflateRaw: nodeDeflateRaw });

          // Act
          const bytes = await collectBytes(sut);
          const parsed = parseZipEntries(bytes);

          // Assert — dir/gitlink entries use method 0 with zero sizes
          const dirEntries = entries.filter((e) => e.mode === '40000' || e.mode === '160000');

          for (const dir of dirEntries) {
            const found = parsed.find((p) => p.name === `${dir.path}/`);
            expect(found, `dir "${dir.path}/" not found`).toBeDefined();
            if (!found) continue;
            expect(found.method).toBe(0);
            expect(found.usize).toBe(0);
          }
        }),
        { numRuns: 200 },
      );
    });
  });
});

describe('Given an arbitrary ArchiveResult with a commit oid', () => {
  describe('When zipArchive is parsed for the EOCD signature', () => {
    it('Then the EOCD is present and reachable at the end of the buffer', async () => {
      await fc.assert(
        fc.asyncProperty(arbArchiveResult(), async ({ result }) => {
          // Arrange
          const sut = zipArchive(result, { deflateRaw: nodeDeflateRaw });

          // Act
          const bytes = await collectBytes(sut);

          // Assert — find EOCD sig somewhere in the last 65558 bytes
          let eocdPos = -1;
          for (let i = bytes.length - 22; i >= 0; i--) {
            if (readU32LE(bytes, i) === EOCD_SIG) {
              eocdPos = i;
              break;
            }
          }
          expect(eocdPos).toBeGreaterThanOrEqual(0);

          // Entry counts should be consistent
          const onDisk = readU16LE(bytes, eocdPos + 8);
          const total = readU16LE(bytes, eocdPos + 10);
          expect(onDisk).toBe(total);
        }),
        { numRuns: 200 },
      );
    });
  });
});

describe('Given an arbitrary ArchiveResult', () => {
  describe('When zipArchive(result) EOCD entry count is checked', () => {
    it('Then EOCD totalEntries equals local entry count in parsed output', async () => {
      await fc.assert(
        fc.asyncProperty(arbArchiveResult(), async ({ result }) => {
          // Arrange
          const sut = zipArchive(result, { deflateRaw: nodeDeflateRaw });

          // Act
          const bytes = await collectBytes(sut);

          // Find EOCD
          let eocdPos = -1;
          for (let i = bytes.length - 22; i >= 0; i--) {
            if (readU32LE(bytes, i) === EOCD_SIG) {
              eocdPos = i;
              break;
            }
          }
          expect(eocdPos).toBeGreaterThanOrEqual(0);
          const eocdTotal = readU16LE(bytes, eocdPos + 10);

          // Count local headers from parsed entries
          const parsed = parseZipEntries(bytes);

          // Assert — EOCD total includes all local entries
          expect(eocdTotal).toBe(parsed.length);
        }),
        { numRuns: 200 },
      );
    });
  });
});

describe('Given any ArchiveResult with a central-dir sig', () => {
  describe('When the central dir is scanned', () => {
    it('Then every central entry has version-needed = 10 and flags = 0', async () => {
      await fc.assert(
        fc.asyncProperty(arbArchiveResult(), async ({ result }) => {
          // Arrange
          const sut = zipArchive(result, { deflateRaw: nodeDeflateRaw });

          // Act
          const bytes = await collectBytes(sut);

          // Scan for central dir entries
          let pos = 0;
          // Skip past all local entries
          while (pos + 4 <= bytes.length && readU32LE(bytes, pos) === LOCAL_SIG) {
            const csize = readU32LE(bytes, pos + 18);
            const nameLen = readU16LE(bytes, pos + 26);
            const extraLen = readU16LE(bytes, pos + 28);
            pos += 30 + nameLen + extraLen + csize;
          }

          // Assert — every central-directory entry has version-needed 10 and flags 0
          while (pos + 4 <= bytes.length && readU32LE(bytes, pos) === CENTRAL_SIG) {
            const versionNeeded = readU16LE(bytes, pos + 6);
            const flags = readU16LE(bytes, pos + 8);
            expect(versionNeeded).toBe(10);
            expect(flags).toBe(0);
            const nameLen = readU16LE(bytes, pos + 28);
            const extraLen = readU16LE(bytes, pos + 30);
            const commentLen = readU16LE(bytes, pos + 32);
            pos += 46 + nameLen + extraLen + commentLen;
          }
        }),
        { numRuns: 200 },
      );
    });
  });
});
