import { compareBytes, hexToBytes } from '../../../../src/domain/objects/encoding.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';

export { arbObjectId } from '../objects/arbitraries.js';

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
