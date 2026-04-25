import { bytesToHex } from './encoding.js';
import { invalidObjectId } from './error.js';

const SHA1_HEX_RE = /^[0-9a-f]{40}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export type ObjectId = string & { readonly __brand: unique symbol };

export const ObjectId = {
  from(hex: string): ObjectId {
    if (!SHA1_HEX_RE.test(hex) && !SHA256_HEX_RE.test(hex)) {
      throw invalidObjectId(hex);
    }
    return hex as ObjectId;
  },

  fromRaw(bytes: Uint8Array): ObjectId {
    if (bytes.length !== 20 && bytes.length !== 32) {
      throw invalidObjectId(`raw bytes length ${bytes.length} is not 20 or 32`);
    }
    return ObjectId.from(bytesToHex(bytes));
  },
} as const;

export const ZERO_OID: ObjectId = ObjectId.from('0000000000000000000000000000000000000000');

export type RefName = string & { readonly __brand: unique symbol };

export const RefName = {
  from(name: string): RefName {
    if (name === '') {
      throw new Error('RefName must not be empty');
    }
    return name as RefName;
  },
} as const;

export type FilePath = string & { readonly __brand: unique symbol };

export const FilePath = {
  from(path: string): FilePath {
    if (path === '') {
      throw new Error('FilePath must not be empty');
    }
    return path as FilePath;
  },
} as const;
