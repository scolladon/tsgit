/**
 * Fault-classification predicates and pack-name safety helpers shared by the
 * pack registry, the multi-pack-index binding, and — through the registry's
 * re-exports — the fsck pack and midx passes.
 */
import { TsgitError, type TsgitErrorData } from '../../../domain/error.js';

function isSkippableIoFault(err: unknown): boolean {
  return (
    err instanceof TsgitError &&
    (err.data.code === 'FILE_NOT_FOUND' || err.data.code === 'PERMISSION_DENIED')
  );
}

// The pack file itself is unusable: bad signature, short file, version outside
// 2|3, or a header/index object-count disagreement. Scoped to the lookup layer
// ONLY — INVALID_PACK_INDEX is deliberately absent, because nextOffsetForEntry
// and buildOffsetTable throw it for a MID-READ corruption, and folding those in
// would turn a detected corruption into a silent miss after the gate passed.
// Exported so a test can audit that it never admits INVALID_MULTI_PACK_INDEX —
// a midx fault escaping this allow-list by construction is the whole
// argument for why a Tier-A multi-pack-index fault is never laundered into
// "skip one pack".
export function isSkippablePackFault(err: unknown): err is TsgitError {
  return (
    (err instanceof TsgitError && err.data.code === 'INVALID_PACK_HEADER') ||
    isSkippableIoFault(err)
  );
}

// Scan layer: the .idx cannot be turned into a PackIndex (a corrupt or
// unreadable index). Deliberately NOT unioned with isSkippablePackFault —
// INVALID_PACK_INDEX is skippable only here, where the parse happens; at the
// lookup layer it also means a mid-read corruption, which must never be
// laundered into "this pack has no objects". Exported for the same audit
// reason as isSkippablePackFault above.
export function isSkippableIdxFault(err: unknown): err is TsgitError {
  return (
    (err instanceof TsgitError && err.data.code === 'INVALID_PACK_INDEX') || isSkippableIoFault(err)
  );
}

// Flat and string-valued on purpose: the Logger port sanitises TOP-LEVEL string
// values only, and a pack name comes from a readdir entry an attacker with repo
// write access controls. Nesting `err.data` would route it round the sanitiser.
export const faultContext = (data: TsgitErrorData): Readonly<Record<string, string>> =>
  'reason' in data ? { code: data.code, reason: data.reason } : { code: data.code };

/** The one narrowing of a fault's display reason — shared with the fsck pack pass. */
export const faultReason = (data: TsgitErrorData): string =>
  'reason' in data ? data.reason : data.code;

// Control characters are rejected at this boundary so a hostile filename can
// never carry a newline into a line-oriented logger sink downstream — the
// display sanitiser deliberately preserves tab and newline.
const isControlChar = (ch: string): boolean => ch.charCodeAt(0) < 0x20;

export function isSafePackName(name: string): boolean {
  return (
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..') &&
    ![...name].some(isControlChar)
  );
}

// Single source for the `.idx` → base-name rule: both the scan layer's
// sibling-.pack check and loadPack's own packPath derivation depend on it.
export const packBaseName = (idxEntryName: string): string => idxEntryName.slice(0, -'.idx'.length);
