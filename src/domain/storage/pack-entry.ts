import { bytesToHex } from '../objects/encoding.js';
import type { HashConfig, ObjectId, ObjectType } from '../objects/index.js';
import { invalidPackEntry, invalidPackHeader } from './error.js';

export const PACK_ENTRY_TYPE = {
  COMMIT: 1,
  TREE: 2,
  BLOB: 3,
  TAG: 4,
  OFS_DELTA: 6,
  REF_DELTA: 7,
} as const;

export type PackEntryType = (typeof PACK_ENTRY_TYPE)[keyof typeof PACK_ENTRY_TYPE];

export type BasePackEntryType =
  | typeof PACK_ENTRY_TYPE.COMMIT
  | typeof PACK_ENTRY_TYPE.TREE
  | typeof PACK_ENTRY_TYPE.BLOB
  | typeof PACK_ENTRY_TYPE.TAG;

interface BasePackEntryHeader {
  readonly type:
    | typeof PACK_ENTRY_TYPE.COMMIT
    | typeof PACK_ENTRY_TYPE.TREE
    | typeof PACK_ENTRY_TYPE.BLOB
    | typeof PACK_ENTRY_TYPE.TAG;
  readonly size: number;
  readonly dataOffset: number;
}

interface OfsPackEntryHeader {
  readonly type: typeof PACK_ENTRY_TYPE.OFS_DELTA;
  readonly size: number;
  readonly dataOffset: number;
  readonly baseDistance: number;
}

interface RefPackEntryHeader {
  readonly type: typeof PACK_ENTRY_TYPE.REF_DELTA;
  readonly size: number;
  readonly dataOffset: number;
  readonly baseId: ObjectId;
}

export type PackEntryHeader = BasePackEntryHeader | OfsPackEntryHeader | RefPackEntryHeader;

export type { BasePackEntryHeader, OfsPackEntryHeader, RefPackEntryHeader };

export interface PackHeader {
  readonly version: number;
  readonly objectCount: number;
}

const PACK_MAGIC = 0x5041434b;
const PACK_HEADER_SIZE = 12;

export function parsePackHeader(bytes: Uint8Array): PackHeader {
  if (bytes.length < PACK_HEADER_SIZE) {
    throw invalidPackHeader('truncated: pack header requires 12 bytes');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0);
  if (magic !== PACK_MAGIC) {
    throw invalidPackHeader(
      `invalid magic: expected 0x5041434b, got 0x${magic.toString(16).padStart(8, '0')}`,
    );
  }
  const version = view.getUint32(4);
  if (version !== 2) {
    throw invalidPackHeader(`unsupported version: expected 2, got ${version}`);
  }
  const objectCount = view.getUint32(8);
  return { version, objectCount };
}

export function serializePackHeader(version: number, objectCount: number): Uint8Array {
  const bytes = new Uint8Array(PACK_HEADER_SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, PACK_MAGIC);
  view.setUint32(4, version);
  view.setUint32(8, objectCount);
  return bytes;
}

const MAX_SIZE_EXTENSION_BYTES = 5;

function decodeTypeAndSize(
  bytes: Uint8Array,
  offset: number,
): { readonly type: number; readonly size: number; readonly nextPos: number } {
  if (offset >= bytes.length) {
    throw invalidPackEntry(offset, 'unexpected end of header');
  }
  let pos = offset;
  const firstByte = bytes[pos]!;
  const type = (firstByte >> 4) & 0x07;
  let size = firstByte & 0x0f;
  let shift = 4;
  let extensionBytes = 0;

  while ((bytes[pos]! & 0x80) !== 0) {
    extensionBytes += 1;
    if (extensionBytes > MAX_SIZE_EXTENSION_BYTES) {
      throw invalidPackEntry(offset, 'size encoding too long');
    }
    pos += 1;
    if (pos >= bytes.length) {
      throw invalidPackEntry(offset, 'unexpected end of header');
    }
    size |= (bytes[pos]! & 0x7f) << shift;
    shift += 7;
  }
  return { type, size, nextPos: pos + 1 };
}

const MAX_OFS_DISTANCE_BYTES = 4;

function decodeOfsDistance(
  bytes: Uint8Array,
  pos: number,
  entryOffset: number,
): { readonly distance: number; readonly nextPos: number } {
  if (pos >= bytes.length) {
    throw invalidPackEntry(entryOffset, 'unexpected end of OFS_DELTA distance');
  }
  let currentPos = pos;
  let distance = bytes[currentPos]! & 0x7f;
  let continuationCount = 0;

  while ((bytes[currentPos]! & 0x80) !== 0) {
    continuationCount += 1;
    if (continuationCount > MAX_OFS_DISTANCE_BYTES) {
      throw invalidPackEntry(entryOffset, 'OFS_DELTA distance encoding too long');
    }
    currentPos += 1;
    if (currentPos >= bytes.length) {
      throw invalidPackEntry(entryOffset, 'unexpected end of OFS_DELTA distance');
    }
    distance = ((distance + 1) << 7) | (bytes[currentPos]! & 0x7f);
  }
  return { distance, nextPos: currentPos + 1 };
}

function validateEntryType(type: number, offset: number): void {
  if (type === 5) {
    throw invalidPackEntry(offset, 'reserved type 5');
  }
  if (type < 1 || type > 7) {
    throw invalidPackEntry(offset, `unknown type ${type}`);
  }
}

export function parsePackEntryHeader(
  bytes: Uint8Array,
  offset: number,
  hash: HashConfig,
): PackEntryHeader {
  const { type, size, nextPos: pos } = decodeTypeAndSize(bytes, offset);
  validateEntryType(type, offset);

  if (type === PACK_ENTRY_TYPE.OFS_DELTA) {
    const { distance, nextPos } = decodeOfsDistance(bytes, pos, offset);
    return { type: PACK_ENTRY_TYPE.OFS_DELTA, size, dataOffset: nextPos, baseDistance: distance };
  }

  if (type === PACK_ENTRY_TYPE.REF_DELTA) {
    const endPos = pos + hash.digestLength;
    if (endPos > bytes.length) {
      throw invalidPackEntry(offset, 'unexpected end of REF_DELTA base id');
    }
    const baseId = bytesToHex(bytes.subarray(pos, endPos)) as ObjectId;
    return { type: PACK_ENTRY_TYPE.REF_DELTA, size, dataOffset: endPos, baseId };
  }

  return { type: type as BasePackEntryType, size, dataOffset: pos };
}

export function encodePackEntryHeader(type: PackEntryType, size: number): Uint8Array {
  const result: number[] = [];
  let firstByte = ((type & 0x07) << 4) | (size & 0x0f);
  let remaining = size >>> 4;

  if (remaining > 0) {
    firstByte |= 0x80;
  }
  result.push(firstByte);

  while (remaining > 0) {
    let nextByte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) {
      nextByte |= 0x80;
    }
    result.push(nextByte);
  }

  return new Uint8Array(result);
}

export function encodeOfsDistance(distance: number): Uint8Array {
  const result: number[] = [];
  result.push(distance & 0x7f);
  let remaining = distance >>> 7;

  while (remaining > 0) {
    remaining -= 1;
    result.push(0x80 | (remaining & 0x7f));
    remaining >>>= 7;
  }

  result.reverse();
  return new Uint8Array(result);
}

const TYPE_TO_OBJECT_TYPE: ReadonlyMap<PackEntryType, ObjectType> = new Map([
  [PACK_ENTRY_TYPE.COMMIT, 'commit'],
  [PACK_ENTRY_TYPE.TREE, 'tree'],
  [PACK_ENTRY_TYPE.BLOB, 'blob'],
  [PACK_ENTRY_TYPE.TAG, 'tag'],
]);

export function packEntryTypeToObjectType(type: PackEntryType): ObjectType | undefined {
  return TYPE_TO_OBJECT_TYPE.get(type);
}
