import {
  decodeEscapingInvalid,
  decodePreservingBom,
  decodesLosslessly,
  encode,
  encodeEscaped,
  hasEscapedBytes,
} from '../objects/encoding.js';
import type { FilePath } from '../objects/index.js';

export interface IndexPath {
  readonly path: FilePath;
  readonly pathBytes?: Uint8Array;
}

export type IndexPathKey = string & { readonly __brand: 'IndexPathKey' };

const SLASH = 0x2f;

export const latin1 = (bytes: Uint8Array): string => {
  let key = '';
  for (const byte of bytes) key += String.fromCharCode(byte);
  return key;
};

export const isLossy = (entry: IndexPath): boolean => entry.pathBytes !== undefined;

export const escapedPathOf = (entry: IndexPath): FilePath =>
  entry.pathBytes === undefined ? entry.path : (decodeEscapingInvalid(entry.pathBytes) as FilePath);

export const indexPathKey = (entry: IndexPath): IndexPathKey =>
  escapedPathOf(entry) as string as IndexPathKey;

export const keyOfPath = (path: FilePath): IndexPathKey => path as string as IndexPathKey;

export const pathBytesOf = (entry: IndexPath): Uint8Array => entry.pathBytes ?? encode(entry.path);

export const indexPathOfBytes = (bytes: Uint8Array): IndexPath => {
  const path = decodePreservingBom(bytes) as FilePath;
  return decodesLosslessly(path, bytes) ? { path } : { path, pathBytes: bytes.slice() };
};

export const indexPathOfEscaped = (path: FilePath): IndexPath =>
  hasEscapedBytes(path) ? indexPathOfBytes(encodeEscaped(path)) : { path };

// Round-trips through bytes: WHATWG maps a maximal subpart to ONE U+FFFD, which a per-escape
// replacement would not.
export const viewOfEscaped = (path: FilePath): FilePath =>
  hasEscapedBytes(path) ? (decodePreservingBom(encodeEscaped(path)) as FilePath) : path;

export const splitAtSlash = (bytes: Uint8Array): Uint8Array[] => {
  const parts: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== SLASH) continue;
    parts.push(bytes.subarray(start, i));
    start = i + 1;
  }
  parts.push(bytes.subarray(start));
  return parts;
};
