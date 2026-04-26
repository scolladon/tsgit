import type { RefName } from '../../../domain/objects/object-id.js';
import { refspecInvalid } from '../../../domain/protocol/error.js';

export const MAX_REFSPECS_PER_FETCH = 1024;

interface ParsedRefspec {
  readonly force: boolean;
  readonly src: string;
  readonly dst: string;
  readonly hasWildcard: boolean;
}

const STAR = '*';

/**
 * Parse a Git refspec of the form `[+]src:dst`.
 *
 * - Leading `+` means force-update (allow non-fast-forward on the local side).
 * - `*` may appear once in `src` and once in `dst`; both sides must agree
 *   (wildcard ↔ wildcard, exact ↔ exact). A mismatch throws `REFSPEC_INVALID`.
 *
 * Throws `REFSPEC_INVALID` for missing colon, NUL bytes, empty sides, or
 * inconsistent wildcards.
 */
export const parseRefspec = (raw: string): ParsedRefspec => {
  if (raw.includes('\0')) throw refspecInvalid(raw, 'contains NUL byte');
  const force = raw.startsWith('+');
  const body = force ? raw.slice(1) : raw;
  const colon = body.indexOf(':');
  if (colon === -1) throw refspecInvalid(raw, 'missing ":" separator');
  const src = body.slice(0, colon);
  const dst = body.slice(colon + 1);
  if (src === '' || dst === '') throw refspecInvalid(raw, 'src and dst must be non-empty');
  const srcHasStar = src.includes(STAR);
  const dstHasStar = dst.includes(STAR);
  if (srcHasStar !== dstHasStar) {
    throw refspecInvalid(raw, 'wildcard mismatch between src and dst');
  }
  if (srcHasStar && (src.split(STAR).length > 2 || dst.split(STAR).length > 2)) {
    throw refspecInvalid(raw, 'each side may contain at most one "*"');
  }
  return { force, src, dst, hasWildcard: srcHasStar };
};

/**
 * Apply a parsed refspec to a ref. Returns the mapped destination, or
 * `undefined` if the ref does not match the spec.
 */
export const applyRefspec = (spec: ParsedRefspec, ref: RefName): RefName | undefined => {
  if (!spec.hasWildcard) {
    return ref === spec.src ? (spec.dst as RefName) : undefined;
  }
  const [srcPrefix, srcSuffix] = splitOnStar(spec.src);
  const [dstPrefix, dstSuffix] = splitOnStar(spec.dst);
  if (!ref.startsWith(srcPrefix) || !ref.endsWith(srcSuffix)) return undefined;
  const captured = ref.slice(srcPrefix.length, ref.length - srcSuffix.length);
  return `${dstPrefix}${captured}${dstSuffix}` as RefName;
};

const splitOnStar = (s: string): [string, string] => {
  const idx = s.indexOf(STAR);
  return [s.slice(0, idx), s.slice(idx + 1)];
};
