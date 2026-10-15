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

// NUL never occurs in a valid entry path, so a lossy key can never equal a UTF-8 key.
const LOSSY_KEY_PREFIX = '\0';
const SLASH = 0x2f;

export const latin1 = (bytes: Uint8Array): string => {
  let key = '';
  for (const byte of bytes) key += String.fromCharCode(byte);
  return key;
};

export const indexPathKey = (entry: IndexPath): IndexPathKey =>
  (entry.pathBytes === undefined
    ? entry.path
    : LOSSY_KEY_PREFIX + latin1(entry.pathBytes)) as IndexPathKey;

export const isLossy = (entry: IndexPath): boolean => entry.pathBytes !== undefined;

export const escapedPathOf = (entry: IndexPath): FilePath =>
  entry.pathBytes === undefined ? entry.path : (decodeEscapingInvalid(entry.pathBytes) as FilePath);

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
