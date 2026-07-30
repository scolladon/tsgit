import type { LineDigest, LineKey } from '../../../../src/domain/diff/whitespace.js';
import { normalizeLine } from '../../../../src/domain/diff/whitespace.js';

// Independent oracle for digestNormalizedLine: FNV-1a folded over normalizeLine's
// OWN output (content bytes, plus a trailing LF byte when normalized ends in one).
// normalizeLine is a genuinely separate code path from the fold under test, so a
// branch/off-by-one/reset bug in the fold almost never coincidentally reproduces
// the same {length, terminated, hash} triple.
export const FNV_OFFSET_BASIS = 0x811c9dc5;
export const FNV_PRIME = 0x01000193;

export function fnvFold(bytes: Uint8Array): number {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of bytes) {
    hash = Math.imul(hash ^ byte, FNV_PRIME) >>> 0;
  }
  return hash;
}

export function expectedDigest(input: Uint8Array, key: LineKey): LineDigest {
  const normalized = normalizeLine(input, key);
  const terminated = normalized.length > 0 && normalized[normalized.length - 1] === 0x0a;
  const length = terminated ? normalized.length - 1 : normalized.length;
  return { length, terminated, hash: fnvFold(normalized) };
}
