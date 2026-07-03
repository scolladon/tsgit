/**
 * Pure boundary predicates + named error-reason constants.
 *
 * Each predicate is exported and tested in isolation with a just-under / at /
 * just-over triple, killing boundary-operator mutants in a single test surface
 * instead of spreading coverage across every call site.
 *
 * Reason strings are exported as `const` so tests reference them by identity
 * (`expect(err.data.reason).toBe(REASON_X)`), which kills StringLiteral mutants
 * on the declaration site.
 */
import {
  MAX_COMMIT_MESSAGE_BYTES,
  MAX_INDEX_BYTES,
  MAX_PEEL_DEPTH,
  MAX_SYMBOLIC_REF_DEPTH,
  MAX_WALK_SEEDS,
} from './types.js';

/* ──────────────── walkCommits ──────────────── */

export const REASON_WALK_EMPTY_FROM = 'empty from' as const;
export const REASON_WALK_TOO_MANY_SEEDS = 'too many seeds' as const;
export const REASON_WALK_QUEUE_OVERFLOW = 'walk queue exceeds bound' as const;

export function isEmptyFrom(from: ReadonlyArray<unknown>): boolean {
  return from.length === 0;
}

export function exceedsMaxWalkSeeds(from: ReadonlyArray<unknown>): boolean {
  return from.length > MAX_WALK_SEEDS;
}

/* ──────────────── createCommit ──────────────── */

export const REASON_MESSAGE_CONTAINS_NUL = 'message contains NUL' as const;
export const REASON_MESSAGE_EXCEEDS_MAX = 'message exceeds 16 MiB' as const;
export const REASON_GPG_SIGNATURE_INJECTION =
  'gpgSignature contains header-boundary chars' as const;
export const REASON_EXTRA_HEADER_INJECTION =
  'extraHeader value contains header-boundary chars' as const;
export const REASON_EXTRA_HEADER_KEY_INVALID =
  'extraHeader key contains forbidden characters' as const;

export function messageContainsNul(message: string): boolean {
  return message.includes('\0');
}

/**
 * Reject characters that would escape the git object wire format's
 * `headers\n\nmessage` boundary when a header-bound value (gpgSignature,
 * extraHeader value) is serialized:
 *
 *  - NUL and CR: raw control bytes that the domain serializer does not fold;
 *    CR in particular flips to CRLF on some readers, shifting the boundary.
 *  - `\n\n`: direct message-boundary smuggle.
 *  - Leading or trailing `\n`: the continuation-line encoder handles interior
 *    LFs by prefixing a space, but a leading/trailing LF produces a blank
 *    continuation that parsers may merge ambiguously with adjacent headers.
 */
export function hasHeaderInjectionChars(value: string): boolean {
  if (value.includes('\0') || value.includes('\r')) return true;
  if (value.includes('\n\n')) return true;
  if (value.startsWith('\n') || value.endsWith('\n')) return true;
  return false;
}

/**
 * Narrower sibling of `hasHeaderInjectionChars` for the `gpgSignature` field
 * only: a genuine OpenPGP/SSH armor block contains a blank line after its
 * `-----BEGIN … SIGNATURE-----` marker and a trailing `\n`, both of which the
 * broader guard rejects. Only NUL and CR can actually inject a spurious
 * header once `formatContinuationHeader` space-prefixes interior LFs, so
 * those are the only characters this predicate rejects.
 */
export function hasSignatureInjectionChars(value: string): boolean {
  return value.includes('\0') || value.includes('\r');
}

export function exceedsMaxCommitMessageBytes(message: string): boolean {
  return new TextEncoder().encode(message).byteLength > MAX_COMMIT_MESSAGE_BYTES;
}

/**
 * Reject any character that would let a header key escape the wire format
 * `<key> <value>\n` boundary or break header parsing entirely:
 *   - empty: no key at all
 *   - NUL / CR / LF: control bytes that re-anchor the parser
 *   - space / tab: a space is the key/value separator; an embedded one is ambiguous
 */
export function isInvalidExtraHeaderKey(key: string): boolean {
  if (key.length === 0) return true;
  if (key.includes('\0') || key.includes('\r') || key.includes('\n')) return true;
  if (key.includes(' ') || key.includes('\t')) return true;
  return false;
}

/* ──────────────── readIndex ──────────────── */

export const REASON_INDEX_EXCEEDS_MAX = 'index file exceeds 256 MiB' as const;
export const REASON_INDEX_CHECKSUM_MISMATCH = 'index trailer checksum mismatch' as const;
export const REASON_PACK_IDX_EXCEEDS_MAX = 'pack .idx file exceeds 64 MiB' as const;

export function exceedsMaxIndexBytes(size: number): boolean {
  return size > MAX_INDEX_BYTES;
}

/** Max .idx file size pack-registry will load. 64 MiB covers any realistic pack. */
export const MAX_PACK_IDX_BYTES = 64 * 1024 * 1024;

export function exceedsMaxPackIdxBytes(size: number): boolean {
  return size > MAX_PACK_IDX_BYTES;
}

/* ──────────────── resolveRef ──────────────── */

export const REASON_TARGET_ESCAPES_GIT_DIR = 'target escapes gitDir' as const;

export function exceedsMaxSymbolicDepth(depth: number, cap = MAX_SYMBOLIC_REF_DEPTH): boolean {
  return depth > cap;
}

export function exceedsMaxPeelDepth(depth: number, cap = MAX_PEEL_DEPTH): boolean {
  return depth > cap;
}

/**
 * Check that a ref-name segment (e.g. `refs/heads/main`) does not contain
 * any characters that would let a joined filesystem path escape the gitDir.
 * Returns true when the segment IS safe for path-join.
 */
export function isContainedRefSegment(name: string): boolean {
  if (name.startsWith('/')) return false;
  if (name.includes('\\')) return false;
  if (name.includes(':')) return false;
  if (name.includes('..')) return false;
  return true;
}

/** `HEAD` is the one ref name that bypasses validateRefName (special case). */
export function isHead(name: string): boolean {
  return name === 'HEAD';
}

/* ──────────────── walkTree ──────────────── */

const GITLINK_MODE = '160000';

export function isGitlink(mode: string): boolean {
  return mode === GITLINK_MODE;
}

export function exceedsMaxTreeDepth(depth: number, cap: number): boolean {
  return depth > cap;
}

export function exceedsMaxTreeEntries(count: number, cap: number): boolean {
  return count > cap;
}

/* ──────────────── readTree / readObject helpers ──────────────── */

const OBJECT_ID_SHA1_RE = /^[0-9a-f]{40}$/;
const OBJECT_ID_SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Return true when a string is a valid SHA1 (40 hex chars) or SHA256 (64 hex chars).
 * Used by readTree to decide whether its `RefName | ObjectId` argument is already an id.
 */
export function looksLikeObjectId(value: string): boolean {
  return OBJECT_ID_SHA1_RE.test(value) || OBJECT_ID_SHA256_RE.test(value);
}

/* ──────────────── writeObject ──────────────── */

/** A declared id is present if the caller pre-populated it (non-empty). */
export function hasDeclaredId(id: string): boolean {
  return id !== '';
}
