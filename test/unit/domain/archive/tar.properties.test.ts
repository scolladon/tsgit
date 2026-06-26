/**
 * Lens-1 round-trip property for the tar serializer.
 *
 * Property: tarArchive(result) can be parsed back by a MINIMAL IN-TEST TAR
 * READER (an independent oracle — NOT sharing code with the writer) to recover
 * the original entry set (paths, mapped modes, sizes, link targets), modulo
 * the synthesised pax/dir framing and EOF padding.
 *
 * numRuns: 200 (cheap round-trip property, per CLAUDE.md policy).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { tarArchive } from '../../../../src/domain/archive/tar.js';
import { arbArchiveResult } from './arbitraries.js';

// ---------------------------------------------------------------------------
// Independent oracle: minimal tar reader
//
// This reader is intentionally kept small and primitive.  It does NOT share
// any code with tar.ts — different field-access approach, different loop
// structure, different checksum computation — so using it as the property
// oracle cannot produce a tautology.
// ---------------------------------------------------------------------------

const HEADER_SIZE = 512;

interface ParsedEntry {
  readonly name: string; // full path from name + prefix fields
  readonly modeOctal: number; // mode field as integer
  readonly size: number; // size field
  readonly typeflag: string; // single char typeflag
  readonly linkname: string; // linkname field (null-terminated)
  readonly data: Uint8Array; // data bytes (trimmed to `size`)
}

/** Read a null-terminated ASCII string from `buf[offset..offset+len]`. */
function readStr(buf: Uint8Array, offset: number, len: number): string {
  let end = offset;
  while (end < offset + len && buf[end] !== 0) end++;
  return String.fromCharCode(...buf.slice(offset, end));
}

/** Parse null-terminated octal field to integer. */
function readOct(buf: Uint8Array, offset: number, len: number): number {
  const s = readStr(buf, offset, len).trim();
  return s === '' ? 0 : Number.parseInt(s, 8);
}

/** True iff a 512-byte block is all zeros (EOF sentinel). */
function isZeroBlock(buf: Uint8Array, offset: number): boolean {
  for (let i = offset; i < offset + HEADER_SIZE; i++) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

/**
 * Parse a tar stream (Uint8Array) into an array of entries.
 * Skips pax global headers (typeflag 'g') and EOF blocks.
 */
function parseTar(tar: Uint8Array): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  let pos = 0;

  while (pos + HEADER_SIZE <= tar.length) {
    if (isZeroBlock(tar, pos)) {
      // EOF sentinel — stop
      break;
    }

    const nameField = readStr(tar, pos + 0, 100);
    const prefixField = readStr(tar, pos + 345, 155);
    const fullName = prefixField !== '' ? `${prefixField}/${nameField}` : nameField;
    const modeOctal = readOct(tar, pos + 100, 8);
    const size = readOct(tar, pos + 124, 12);
    const typeflag = String.fromCharCode(tar[pos + 156] ?? 0x30);
    const linkname = readStr(tar, pos + 157, 100);

    pos += HEADER_SIZE;

    // Compute data block span (rounded up to 512-byte boundary)
    const dataBlocks = Math.ceil(size / HEADER_SIZE);
    const data = size > 0 ? tar.slice(pos, pos + size) : new Uint8Array(0);
    pos += dataBlocks * HEADER_SIZE;

    // Skip pax global headers
    if (typeflag === 'g') continue;

    entries.push({ name: fullName, modeOctal, size, typeflag, linkname, data });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Expected mode mapping from git mode string → tar mode integer (umask=0002)
// Independent computation — does NOT call any code from tar.ts.
// ---------------------------------------------------------------------------
const DEFAULT_UMASK = 0o0002;

function expectedTarMode(gitMode: string): number {
  switch (gitMode) {
    case '100644':
      return 0o0666 & ~DEFAULT_UMASK; // 0664
    case '100755':
      return 0o0777 & ~DEFAULT_UMASK; // 0775
    case '40000':
      return 0o0777 & ~DEFAULT_UMASK; // 0775
    case '160000':
      return 0o0777 & ~DEFAULT_UMASK; // 0775
    case '120000':
      return 0o0777; // unmasked
    default:
      return 0;
  }
}

function expectedTypeflag(gitMode: string): string {
  switch (gitMode) {
    case '100644':
    case '100755':
      return '0';
    case '120000':
      return '2';
    case '40000':
    case '160000':
      return '5';
    default:
      return '?';
  }
}

function hasData(gitMode: string): boolean {
  return gitMode === '100644' || gitMode === '100755';
}

// ---------------------------------------------------------------------------
// Collect async iterable to Uint8Array
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
// Property: round-trip
// ---------------------------------------------------------------------------

describe('Given an arbitrary ArchiveResult', () => {
  describe('When tarArchive(result) is parsed by the independent oracle', () => {
    it('Then every original entry round-trips: path, mapped mode, size, link target', async () => {
      await fc.assert(
        fc.asyncProperty(arbArchiveResult(), async ({ entries, result, commitTime }) => {
          // Arrange — fixed mtime so EOF padding is deterministic
          const mtime = commitTime ?? 0;
          const sut = tarArchive(result, { mtime });

          // Act
          const bytes = await collectBytes(sut);
          const parsed = parseTar(bytes);

          // Assert — filter out the synthesised EOF entries (no pax, no prefix here)
          // The oracle already skips pax ('g') blocks.
          // Each original entry must appear in parsed with correct fields.
          for (const entry of entries) {
            const isDir = entry.mode === '40000' || entry.mode === '160000';
            const expectedName = isDir ? `${entry.path}/` : entry.path;
            const found = parsed.find((p) => p.name === expectedName);

            expect(found, `entry ${entry.path} not found in parsed tar`).toBeDefined();
            if (!found) continue;

            expect(found.modeOctal).toBe(expectedTarMode(entry.mode));
            expect(found.typeflag).toBe(expectedTypeflag(entry.mode));

            if (entry.mode === '120000' && entry.content !== undefined) {
              // Symlink target is in linkname field
              const expectedTarget = String.fromCharCode(...entry.content);
              expect(found.linkname).toBe(expectedTarget);
              expect(found.size).toBe(0);
            } else if (hasData(entry.mode) && entry.content !== undefined) {
              expect(found.size).toBe(entry.content.length);
              expect(found.data).toEqual(entry.content);
            }
          }
        }),
        { numRuns: 200 },
      );
    });
  });
});
