import { decode, encode, indexOf } from './encoding.js';
import { invalidObjectHeader } from './error.js';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

const VALID_TYPES: ReadonlySet<string> = new Set(['blob', 'tree', 'commit', 'tag']);

export function parseHeader(rawBytes: Uint8Array): {
  readonly type: ObjectType;
  readonly size: number;
  readonly contentOffset: number;
} {
  const nullIndex = indexOf(rawBytes, 0x00, 0);
  if (nullIndex === -1) {
    throw invalidObjectHeader('missing null terminator');
  }

  const headerStr = decode(rawBytes.subarray(0, nullIndex));
  const spaceIndex = headerStr.indexOf(' ');
  if (spaceIndex === -1) {
    throw invalidObjectHeader('missing space between type and size');
  }

  const type = headerStr.slice(0, spaceIndex);
  if (!VALID_TYPES.has(type)) {
    throw invalidObjectHeader(`unknown object type: ${type}`);
  }

  const sizeStr = headerStr.slice(spaceIndex + 1);
  const size = Number(sizeStr);
  if (!Number.isFinite(size) || size < 0 || sizeStr !== String(size)) {
    throw invalidObjectHeader(`invalid size: ${sizeStr}`);
  }

  return { type: type as ObjectType, size, contentOffset: nullIndex + 1 };
}

export function serializeHeader(type: ObjectType, contentSize: number): Uint8Array {
  return encode(`${type} ${contentSize}\0`);
}
