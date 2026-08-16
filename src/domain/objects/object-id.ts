import { bytesToHex } from './encoding.js';
import { invalidObjectId } from './error.js';

const SHA1_HEX_LENGTH = 40;
const SHA256_HEX_LENGTH = 64;

// Inclusive code-unit boundaries of the two accepted ranges: ASCII '0'-'9'
// and ASCII 'a'-'f'. Uppercase hex is deliberately not accepted (R1 keeps
// the accept set byte-identical to the two regexes this replaces).
const DIGIT_ZERO_CODE = 0x30; // '0'
const DIGIT_NINE_CODE = 0x39; // '9'
const LOWER_A_CODE = 0x61; // 'a'
const LOWER_F_CODE = 0x66; // 'f'

function isHexDigitCodeUnit(codeUnit: number): boolean {
  if (codeUnit >= DIGIT_ZERO_CODE && codeUnit <= DIGIT_NINE_CODE) {
    return true;
  }
  return codeUnit >= LOWER_A_CODE && codeUnit <= LOWER_F_CODE;
}

// Scans code units (not code points) so a string is measured the same way
// `String.length`/`charCodeAt` see it — a surrogate half or an astral
// character both land outside the accepted ranges or shift the length,
// exactly like the two regex literals this replaces (no `u` flag).
function isValidObjectIdHex(hex: string): boolean {
  if (hex.length !== SHA1_HEX_LENGTH && hex.length !== SHA256_HEX_LENGTH) {
    return false;
  }
  for (let i = 0; i < hex.length; i += 1) {
    if (!isHexDigitCodeUnit(hex.charCodeAt(i))) {
      return false;
    }
  }
  return true;
}

export type ObjectId = string & { readonly __brand: unique symbol };

export const ObjectId = {
  from(hex: string): ObjectId {
    if (!isValidObjectIdHex(hex)) {
      throw invalidObjectId(hex);
    }
    return hex as ObjectId;
  },

  fromRaw(bytes: Uint8Array): ObjectId {
    if (bytes.length !== 20 && bytes.length !== 32) {
      throw invalidObjectId(`raw bytes length ${bytes.length} is not 20 or 32`);
    }
    // Trusted path: bytesToHex emits only `[0-9a-f]` characters by construction
    // on this length-checked slice, so the regex re-validation `.from` applies
    // to untrusted API-boundary hex is provably vacuous here — skip it.
    return bytesToHex(bytes) as ObjectId;
  },
} as const;

export const ZERO_OID: ObjectId = ObjectId.from('0000000000000000000000000000000000000000');

/**
 * SHA-1 of the canonical empty tree object. Used by `merge` for unrelated-history
 * three-way merges where the merge base is undefined — substituted as the
 * "empty base" so mergeTrees produces the union of both sides.
 */
export const EMPTY_TREE_OID: ObjectId = ObjectId.from('4b825dc642cb6eb9a060e54bf8d69288fbee4904');

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
