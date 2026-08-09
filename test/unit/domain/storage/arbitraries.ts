import fc from 'fast-check';

import { compareBytes, encode, hexToBytes } from '../../../../src/domain/objects/encoding.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';
import { arbObjectId } from '../objects/arbitraries.js';

export { arbObjectId } from '../objects/arbitraries.js';

/** A pack-header version git accepts on read (`pack_version_ok`). */
export const arbSupportedPackVersion = (): fc.Arbitrary<number> => fc.constantFrom(2, 3);

/** Any uint32 outside the accepted set — the complement no finite table enumerates. */
export const arbUnsupportedPackVersion = (): fc.Arbitrary<number> =>
  fc.integer({ min: 0, max: 0xffffffff }).filter((v) => v !== 2 && v !== 3);

export interface TestIndexEntry {
  readonly id: ObjectId;
  readonly offset: number;
  readonly crc32: number;
}

export function buildTestIndex(entries: ReadonlyArray<TestIndexEntry>): Uint8Array {
  const sorted = [...entries].sort((a, b) => compareBytes(hexToBytes(a.id), hexToBytes(b.id)));
  const n = sorted.length;

  const largeOffsetCount = sorted.filter((e) => e.offset > 0x7fffffff).length;

  const headerSize = 8;
  const fanoutSize = 1024;
  const shaTableSize = n * 20;
  const crc32TableSize = n * 4;
  const offsetTableSize = n * 4;
  const largeOffsetTableSize = largeOffsetCount * 8;
  const trailerSize = 40;

  const totalSize =
    headerSize +
    fanoutSize +
    shaTableSize +
    crc32TableSize +
    offsetTableSize +
    largeOffsetTableSize +
    trailerSize;

  const bytes = new Uint8Array(totalSize);
  const view = new DataView(bytes.buffer);

  // Header
  view.setUint32(0, 0xff744f63);
  view.setUint32(4, 2);

  // Fanout table
  const fanout = new Uint32Array(256);
  for (const entry of sorted) {
    const firstByte = Number.parseInt(entry.id.slice(0, 2), 16);
    for (let i = firstByte; i < 256; i++) {
      fanout[i]! += 1;
    }
  }
  for (let i = 0; i < 256; i++) {
    view.setUint32(8 + i * 4, fanout[i]!);
  }

  // SHA table
  const shaStart = headerSize + fanoutSize;
  for (let i = 0; i < n; i++) {
    const sha = hexToBytes(sorted[i]!.id);
    bytes.set(sha, shaStart + i * 20);
  }

  // CRC-32 table
  const crcStart = shaStart + shaTableSize;
  for (let i = 0; i < n; i++) {
    view.setUint32(crcStart + i * 4, sorted[i]!.crc32);
  }

  // Offset table
  const offsetStart = crcStart + crc32TableSize;
  let largeIdx = 0;
  const largeOffsetStart = offsetStart + offsetTableSize;

  for (let i = 0; i < n; i++) {
    const offset = sorted[i]!.offset;
    if (offset > 0x7fffffff) {
      view.setUint32(offsetStart + i * 4, 0x80000000 | largeIdx);
      // Large offset table: 64-bit big-endian (split into high and low 32-bit words)
      const high = Math.floor(offset / 0x100000000);
      const low = offset >>> 0;
      view.setUint32(largeOffsetStart + largeIdx * 8, high);
      view.setUint32(largeOffsetStart + largeIdx * 8 + 4, low);
      largeIdx += 1;
    } else {
      view.setUint32(offsetStart + i * 4, offset);
    }
  }

  // Trailer: 20-byte pack checksum + 20-byte self checksum (zeros)
  return bytes;
}

export function buildDelta(
  sourceLength: number,
  targetLength: number,
  instructions: ReadonlyArray<
    | { readonly type: 'copy'; readonly offset: number; readonly size: number }
    | { readonly type: 'insert'; readonly data: Uint8Array }
  >,
): Uint8Array {
  const parts: number[] = [];

  encodeDeltaVarInt(parts, sourceLength);
  encodeDeltaVarInt(parts, targetLength);

  for (const inst of instructions) {
    if (inst.type === 'copy') {
      encodeCopyInstruction(parts, inst.offset, inst.size);
    } else {
      encodeInsertInstruction(parts, inst.data);
    }
  }

  return new Uint8Array(parts);
}

function encodeDeltaVarInt(out: number[], value: number): void {
  let v = value;
  let byte = v & 0x7f;
  v >>>= 7;
  while (v > 0) {
    out.push(byte | 0x80);
    byte = v & 0x7f;
    v >>>= 7;
  }
  out.push(byte);
}

function encodeCopyInstruction(out: number[], offset: number, size: number): void {
  let cmd = 0x80;
  const offBytes: number[] = [];
  const sizeBytes: number[] = [];

  if ((offset & 0xff) !== 0) {
    cmd |= 0x01;
    offBytes.push(offset & 0xff);
  }
  if ((offset & 0xff00) !== 0) {
    cmd |= 0x02;
    offBytes.push((offset >>> 8) & 0xff);
  }
  if ((offset & 0xff0000) !== 0) {
    cmd |= 0x04;
    offBytes.push((offset >>> 16) & 0xff);
  }
  if ((offset & 0xff000000) !== 0) {
    cmd |= 0x08;
    offBytes.push((offset >>> 24) & 0xff);
  }

  const effectiveSize = size === 0x10000 ? 0 : size;
  if ((effectiveSize & 0xff) !== 0) {
    cmd |= 0x10;
    sizeBytes.push(effectiveSize & 0xff);
  }
  if ((effectiveSize & 0xff00) !== 0) {
    cmd |= 0x20;
    sizeBytes.push((effectiveSize >>> 8) & 0xff);
  }
  if ((effectiveSize & 0xff0000) !== 0) {
    cmd |= 0x40;
    sizeBytes.push((effectiveSize >>> 16) & 0xff);
  }

  out.push(cmd, ...offBytes, ...sizeBytes);
}

function encodeInsertInstruction(out: number[], data: Uint8Array): void {
  out.push(data.length);
  for (const byte of data) {
    out.push(byte);
  }
}

// --- Multi-pack index --------------------------------------------------

const MIDX_HEADER_SIZE = 12;
const MIDX_CHUNK_TABLE_ROW_SIZE = 12;
const MIDX_FANOUT_SIZE = 1024;

export interface MidxEntrySpec {
  readonly id: ObjectId;
  readonly packIndex: number;
  readonly offset: number;
}

export interface MidxSpec {
  readonly version: 1 | 2;
  readonly hashVersion: 1 | 2;
  readonly digestLength: number;
  readonly numBaseFiles: number;
  readonly packNames: ReadonlyArray<string>;
  readonly entries: ReadonlyArray<MidxEntrySpec>;
  /** When present, the midx carries a reverse-index (`RIDX`) chunk with this body. */
  readonly revBody?: ReadonlyArray<number>;
}

/**
 * Writer for the on-disk multi-pack-index layout — the model for
 * `parseMultiPackIndex`'s round-trip oracle. Entries are re-sorted by oid
 * before writing (a midx's OIDL is always sorted), so callers may pass them
 * in any order. The trailer is left as `digestLength` zero bytes: the parser
 * never reads it, so this writer never hashes it.
 */
export function buildMidx(spec: MidxSpec): Uint8Array {
  const { version, hashVersion, digestLength, numBaseFiles, packNames, entries, revBody } = spec;
  const sorted = [...entries].sort((a, b) => compareBytes(hexToBytes(a.id), hexToBytes(b.id)));
  const objectCount = sorted.length;
  const largeOffsets = sorted.map((entry) => entry.offset).filter((offset) => offset > 0x7fffffff);
  const hasLoff = largeOffsets.length > 0;
  const hasRev = revBody !== undefined;
  const numChunks = 4 + (hasRev ? 1 : 0) + (hasLoff ? 1 : 0);

  const nameBytes = packNames.map((name) => encode(`${name}\0`));
  const pnamRawLength = nameBytes.reduce((sum, bytes) => sum + bytes.length, 0);
  const pnamLength = pnamRawLength + ((4 - (pnamRawLength % 4)) % 4);

  const chunkTableSize = (numChunks + 1) * MIDX_CHUNK_TABLE_ROW_SIZE;
  const pnamStart = MIDX_HEADER_SIZE + chunkTableSize;
  const oidfStart = pnamStart + pnamLength;
  const oidlStart = oidfStart + MIDX_FANOUT_SIZE;
  const ooffStart = oidlStart + objectCount * digestLength;
  const revStart = ooffStart + objectCount * 8;
  const loffStart = hasRev ? revStart + revBody!.length * 4 : revStart;
  const trailerStart = hasLoff ? loffStart + largeOffsets.length * 8 : loffStart;

  const bytes = new Uint8Array(trailerStart + digestLength);
  const view = new DataView(bytes.buffer);

  bytes.set(encode('MIDX'), 0);
  view.setUint8(4, version);
  view.setUint8(5, hashVersion);
  view.setUint8(6, numChunks);
  view.setUint8(7, numBaseFiles);
  view.setUint32(8, packNames.length);

  const chunkRows: Array<readonly [string, number]> = [
    ['PNAM', pnamStart],
    ['OIDF', oidfStart],
    ['OIDL', oidlStart],
    ['OOFF', ooffStart],
  ];
  if (hasRev) chunkRows.push(['RIDX', revStart]);
  if (hasLoff) chunkRows.push(['LOFF', loffStart]);
  chunkRows.push(['', trailerStart]);

  chunkRows.forEach(([id, offset], i) => {
    const rowStart = MIDX_HEADER_SIZE + i * MIDX_CHUNK_TABLE_ROW_SIZE;
    if (id !== '') bytes.set(encode(id), rowStart);
    view.setUint32(rowStart + 4, Math.floor(offset / 0x100000000));
    view.setUint32(rowStart + 8, offset >>> 0);
  });

  let nameCursor = pnamStart;
  for (const name of nameBytes) {
    bytes.set(name, nameCursor);
    nameCursor += name.length;
  }

  const fanout = new Uint32Array(256);
  for (const entry of sorted) {
    const firstByte = hexToBytes(entry.id)[0]!;
    for (let i = firstByte; i < 256; i += 1) fanout[i]! += 1;
  }
  for (let i = 0; i < 256; i += 1) view.setUint32(oidfStart + i * 4, fanout[i]!);

  for (let i = 0; i < objectCount; i += 1) {
    bytes.set(hexToBytes(sorted[i]!.id), oidlStart + i * digestLength);
  }

  let largeIndex = 0;
  for (let i = 0; i < objectCount; i += 1) {
    const entry = sorted[i]!;
    view.setUint32(ooffStart + i * 8, entry.packIndex);
    if (entry.offset > 0x7fffffff) {
      view.setUint32(ooffStart + i * 8 + 4, 0x80000000 | largeIndex);
      view.setUint32(loffStart + largeIndex * 8, Math.floor(entry.offset / 0x100000000));
      view.setUint32(loffStart + largeIndex * 8 + 4, entry.offset >>> 0);
      largeIndex += 1;
    } else {
      view.setUint32(ooffStart + i * 8 + 4, entry.offset);
    }
  }

  if (hasRev) {
    revBody!.forEach((value, i) => {
      view.setUint32(revStart + i * 4, value);
    });
  }

  return bytes;
}

/**
 * An arbitrary, internally-consistent midx spec: pack names are generated
 * already lexicographically ordered (zero-padded sequential hex), so the
 * fixture is valid whether or not the reader enforces name ordering, without
 * the generator having to special-case that rule.
 */
export function arbMidxSpec(): fc.Arbitrary<MidxSpec> {
  return fc.constantFrom<1 | 2>(1, 2).chain((version) =>
    fc.constantFrom<1 | 2>(1, 2).chain((hashVersion) => {
      const digestLength = hashVersion === 1 ? 20 : 32;
      const hexLength = hashVersion === 1 ? 40 : 64;
      return fc.integer({ min: 0, max: 8 }).chain((packCount) => {
        const packNames = Array.from(
          { length: packCount },
          (_, i) => `pack-${i.toString(16).padStart(hexLength, '0')}.idx`,
        );
        const maxObjects = packCount === 0 ? 0 : 64;
        return fc
          .record({
            numBaseFiles: fc.integer({ min: 0, max: 255 }),
            ids: fc.uniqueArray(arbObjectId(hexLength), {
              minLength: 0,
              maxLength: maxObjects,
            }),
          })
          .chain((r) =>
            fc
              .array(
                fc.tuple(fc.integer({ min: 0, max: Math.max(packCount - 1, 0) }), arbMidxOffset()),
                { minLength: r.ids.length, maxLength: r.ids.length },
              )
              .map(
                (placements): MidxSpec => ({
                  version,
                  hashVersion,
                  digestLength,
                  numBaseFiles: r.numBaseFiles,
                  packNames,
                  entries: r.ids.map((id, i) => ({
                    id,
                    packIndex: placements[i]![0],
                    offset: placements[i]![1],
                  })),
                }),
              ),
          );
      });
    }),
  );
}

/**
 * `arbMidxSpec` plus a reverse-index (`RIDX`) chunk body matching the
 * generated entry count — the round-trip oracle needs a generator that also
 * exercises the optional chunk.
 */
export function arbMidxSpecWithRev(): fc.Arbitrary<MidxSpec> {
  return arbMidxSpec().chain((spec) =>
    fc
      .array(fc.integer({ min: 0, max: 0xffffffff }), {
        minLength: spec.entries.length,
        maxLength: spec.entries.length,
      })
      .map((revBody): MidxSpec => ({ ...spec, revBody })),
  );
}

function arbMidxOffset(): fc.Arbitrary<number> {
  return fc.oneof(
    fc.integer({ min: 0, max: 0x7fffffff }),
    fc.integer({ min: 0x80000000, max: Number.MAX_SAFE_INTEGER }),
  );
}

// --- Pack reverse index --------------------------------------------------

const REV_HEADER_SIZE = 12;

export interface RevIndexSpec {
  readonly hashId: 1 | 2;
  readonly digestLength: number;
  readonly body: ReadonlyArray<number>;
  readonly packChecksum: Uint8Array;
}

/**
 * Writer for the on-disk pack reverse-index layout — the model for
 * `parsePackRevIndex`'s round-trip oracle. The trailer (`digestLength` bytes:
 * a digest over everything before it) is left as zero bytes: the parser
 * never reads it, so this writer never hashes it.
 */
export function buildRevIndex(spec: RevIndexSpec): Uint8Array {
  const { hashId, digestLength, body, packChecksum } = spec;
  const bodySize = body.length * 4;
  const bytes = new Uint8Array(REV_HEADER_SIZE + bodySize + 2 * digestLength);
  const view = new DataView(bytes.buffer);

  bytes.set(encode('RIDX'), 0);
  view.setUint32(4, 1);
  view.setUint32(8, hashId);
  body.forEach((value, i) => {
    view.setUint32(REV_HEADER_SIZE + i * 4, value);
  });
  bytes.set(packChecksum, REV_HEADER_SIZE + bodySize);

  return bytes;
}

/**
 * An arbitrary rev-index spec. `hashId` and `digestLength` are drawn
 * independently — canonical git accepts the disagreement — and body words
 * are unconstrained integers so the generator also covers non-permutations
 * and out-of-range values without special-casing them.
 */
export function arbRevIndexSpec(): fc.Arbitrary<RevIndexSpec> {
  return fc.constantFrom<1 | 2>(1, 2).chain((hashId) =>
    fc.constantFrom<20 | 32>(20, 32).chain((digestLength) =>
      fc.integer({ min: 0, max: 500 }).chain((objectCount) =>
        fc
          .record({
            body: fc.array(fc.integer({ min: 0, max: 0xffffffff }), {
              minLength: objectCount,
              maxLength: objectCount,
            }),
            packChecksum: fc.uint8Array({ minLength: digestLength, maxLength: digestLength }),
          })
          .map(
            ({ body, packChecksum }): RevIndexSpec => ({
              hashId,
              digestLength,
              body,
              packChecksum,
            }),
          ),
      ),
    ),
  );
}

// --- Pack bitmap: EWAH streams -------------------------------------------

/** Upper bound (exclusive) of the bit-position range `arbBitSet` draws from. */
export const EWAH_BIT_RANGE = 5000;

const EWAH_WORD_BITS = 64;
const EWAH_LOW_HALF_BITS = 32;
const EWAH_CLEAN_COUNT_BITS = 31;

interface EwahWord {
  readonly high: number;
  readonly low: number;
}

function classifyEwahWord(
  bitSet: ReadonlySet<number>,
  wordIndex: number,
): 'clean0' | 'clean1' | 'literal' {
  const base = wordIndex * EWAH_WORD_BITS;
  let setCount = 0;
  for (let p = 0; p < EWAH_WORD_BITS; p += 1) {
    if (bitSet.has(base + p)) setCount += 1;
  }
  if (setCount === 0) return 'clean0';
  if (setCount === EWAH_WORD_BITS) return 'clean1';
  return 'literal';
}

function ewahLiteralWordAt(bitSet: ReadonlySet<number>, wordIndex: number): EwahWord {
  const base = wordIndex * EWAH_WORD_BITS;
  let low = 0;
  let high = 0;
  for (let p = 0; p < EWAH_LOW_HALF_BITS; p += 1) {
    if (bitSet.has(base + p)) low |= 1 << p;
  }
  for (let p = 0; p < EWAH_LOW_HALF_BITS; p += 1) {
    if (bitSet.has(base + EWAH_LOW_HALF_BITS + p)) high |= 1 << p;
  }
  return { high: high >>> 0, low: low >>> 0 };
}

/** Inverse of `readEwahStream`'s run-length decode: bit 0 is the run value,
 *  bits 1-32 (crossing the half boundary) are the clean-word count, bits
 *  33-63 are the following literal-word count. */
function encodeRunLengthWord(runValue: 0 | 1, cleanCount: number, literalCount: number): EwahWord {
  const low = (((cleanCount & 0x7fffffff) << 1) | runValue) >>> 0;
  const high = ((literalCount << 1) | ((cleanCount >>> EWAH_CLEAN_COUNT_BITS) & 1)) >>> 0;
  return { high, low };
}

function writeEwahStreamBytes(bitSize: number, words: ReadonlyArray<EwahWord>): Uint8Array {
  const bytes = new Uint8Array(8 + words.length * 8 + 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bitSize);
  view.setUint32(4, words.length);
  words.forEach((word, i) => {
    view.setUint32(8 + i * 8, word.high);
    view.setUint32(8 + i * 8 + 4, word.low);
  });
  // Trailing rlwPosition (u32): a decoder never reads its value, so this
  // writer never computes one — left as zero bytes.
  return bytes;
}

/**
 * Writer for the on-disk EWAH stream format — the model for
 * `readEwahStream`/`foldEwahStream`'s round-trip oracle. Clusters the bit
 * set into runs of same-valued 64-bit words (clean words) interleaved with
 * literal words, the same clustering git's own writer performs, so a sparse
 * input exercises both run-length and literal words rather than only ever
 * emitting literals. `bitSize = 0` writes git's own empty encoding — one
 * all-zero word, never zero words.
 */
export function encodeEwah(bits: ReadonlyArray<number>, bitSize: number): Uint8Array {
  const bitSet = new Set(bits);
  const wordSpan = Math.ceil(bitSize / EWAH_WORD_BITS);
  const words: EwahWord[] = [];

  let i = 0;
  while (i < wordSpan) {
    const startKind = classifyEwahWord(bitSet, i);
    let cleanEnd = i;
    if (startKind !== 'literal') {
      while (cleanEnd < wordSpan && classifyEwahWord(bitSet, cleanEnd) === startKind) {
        cleanEnd += 1;
      }
    }
    let literalEnd = cleanEnd;
    while (literalEnd < wordSpan && classifyEwahWord(bitSet, literalEnd) === 'literal') {
      literalEnd += 1;
    }

    words.push(
      encodeRunLengthWord(startKind === 'clean1' ? 1 : 0, cleanEnd - i, literalEnd - cleanEnd),
    );
    for (let k = cleanEnd; k < literalEnd; k += 1) {
      words.push(ewahLiteralWordAt(bitSet, k));
    }
    i = literalEnd;
  }

  if (words.length === 0) {
    words.push(encodeRunLengthWord(0, 0, 0));
  }

  return writeEwahStreamBytes(bitSize, words);
}

/** Bit positions over `[0, EWAH_BIT_RANGE)`, drawn from both a sparse
 *  generator (few bits set) and a dense one (few bits CLEAR) — the round-trip
 *  property needs both to exercise `encodeEwah`'s clean-0 AND clean-1 runs. */
export function arbBitSet(): fc.Arbitrary<ReadonlyArray<number>> {
  const position = fc.integer({ min: 0, max: EWAH_BIT_RANGE - 1 });
  const sparse = fc.uniqueArray(position, { maxLength: 60 });
  const dense = fc.uniqueArray(position, { maxLength: 60 }).map((holes) => {
    const holeSet = new Set(holes);
    const bits: number[] = [];
    for (let p = 0; p < EWAH_BIT_RANGE; p += 1) {
      if (!holeSet.has(p)) bits.push(p);
    }
    return bits;
  });
  return fc.oneof(sparse, dense);
}

// --- Pack bitmap: container -----------------------------------------------

const BITMAP_HEADER_SIZE = 12;
const BITMAP_ENTRY_FIXED_SIZE = 6;
/** Mandatory full-DAG bit — every generated spec carries it; clearing it is
 *  a dedicated refusal row in the unit suite, not a shape the round-trip
 *  generator needs to reach. */
const BITMAP_FULL_DAG_FLAG = 0x1;

export interface BitmapStreamSpec {
  readonly bits: ReadonlyArray<number>;
  readonly bitSize: number;
}

export interface BitmapEntrySpec extends BitmapStreamSpec {
  readonly position: number;
  readonly xorOffset: number;
  readonly flags: number;
}

export interface BitmapSpec {
  readonly optionFlags: number;
  readonly digestLength: number;
  readonly checksum: Uint8Array;
  readonly typeStreams: readonly [
    BitmapStreamSpec,
    BitmapStreamSpec,
    BitmapStreamSpec,
    BitmapStreamSpec,
  ];
  readonly entries: ReadonlyArray<BitmapEntrySpec>;
  /** Bytes appended after the last entry — stands in for the hash cache,
   *  lookup table, pseudo-merge table and the file's own trailing digest,
   *  none of which the parser reads. */
  readonly trailingBytes: number;
}

/**
 * Writer for the on-disk pack (or midx) bitmap container layout — the model
 * for `parsePackBitmap`/`bitmapEntryHeaders`'s round-trip oracle. Reuses
 * `encodeEwah` for every stream, so a fixture that exercises EWAH's clean
 * and literal words also exercises the container's own offset arithmetic.
 */
export function buildBitmap(spec: BitmapSpec): Uint8Array {
  const { optionFlags, digestLength, checksum, typeStreams, entries, trailingBytes } = spec;

  const streamBytes = typeStreams.map((stream) => encodeEwah(stream.bits, stream.bitSize));
  const entryBytes = entries.map((entry) => {
    const fixed = new Uint8Array(BITMAP_ENTRY_FIXED_SIZE);
    const fixedView = new DataView(fixed.buffer);
    fixedView.setUint32(0, entry.position);
    fixedView.setUint8(4, entry.xorOffset);
    fixedView.setUint8(5, entry.flags);
    return { fixed, stream: encodeEwah(entry.bits, entry.bitSize) };
  });

  const totalSize =
    BITMAP_HEADER_SIZE +
    digestLength +
    streamBytes.reduce((sum, streamPart) => sum + streamPart.length, 0) +
    entryBytes.reduce((sum, entry) => sum + entry.fixed.length + entry.stream.length, 0) +
    trailingBytes;

  const bytes = new Uint8Array(totalSize);
  const view = new DataView(bytes.buffer);

  bytes.set(encode('BITM'), 0);
  view.setUint16(4, 1);
  view.setUint16(6, optionFlags);
  view.setUint32(8, entries.length);
  bytes.set(checksum, BITMAP_HEADER_SIZE);

  let cursor = BITMAP_HEADER_SIZE + digestLength;
  for (const streamPart of streamBytes) {
    bytes.set(streamPart, cursor);
    cursor += streamPart.length;
  }
  for (const entry of entryBytes) {
    bytes.set(entry.fixed, cursor);
    cursor += entry.fixed.length;
    bytes.set(entry.stream, cursor);
    cursor += entry.stream.length;
  }

  return bytes;
}

function arbBitmapStreamSpec(): fc.Arbitrary<BitmapStreamSpec> {
  return fc.record({
    bitSize: fc.integer({ min: 0, max: EWAH_BIT_RANGE }),
    bits: arbBitSet(),
  });
}

/** Entry `i`'s `xorOffset` is drawn from `[0, i]` — the base must precede,
 *  so a generated chain is acyclic by construction and the parser never has
 *  to reject the generator's own output. */
function arbBitmapEntrySpecs(): fc.Arbitrary<ReadonlyArray<BitmapEntrySpec>> {
  return fc.integer({ min: 0, max: 8 }).chain((count) =>
    fc.tuple(
      ...Array.from({ length: count }, (_, i) =>
        fc.record({
          position: fc.integer({ min: 0, max: 0xffffffff }),
          xorOffset: fc.integer({ min: 0, max: i }),
          flags: fc.integer({ min: 0, max: 255 }),
          bitSize: fc.integer({ min: 0, max: EWAH_BIT_RANGE }),
          bits: arbBitSet(),
        }),
      ),
    ),
  );
}

/**
 * An arbitrary, internally-consistent bitmap spec: `optionFlags` always
 * carries the mandatory full-DAG bit, and `digestLength` is drawn first
 * since both `checksum`'s length and the round-trip's expected offsets
 * depend on it.
 */
export function arbBitmapSpec(): fc.Arbitrary<BitmapSpec> {
  return fc.constantFrom<20 | 32>(20, 32).chain((digestLength) =>
    fc
      .record({
        optionFlags: fc.integer({ min: 0, max: 0xfffe }).map((v) => v | BITMAP_FULL_DAG_FLAG),
        checksum: fc.uint8Array({ minLength: digestLength, maxLength: digestLength }),
        typeStreams: fc.tuple(
          arbBitmapStreamSpec(),
          arbBitmapStreamSpec(),
          arbBitmapStreamSpec(),
          arbBitmapStreamSpec(),
        ),
        entries: arbBitmapEntrySpecs(),
        trailingBytes: fc.integer({ min: 0, max: 16 }),
      })
      .map((r): BitmapSpec => ({ ...r, digestLength })),
  );
}
