/**
 * git's `parse_refspec` as a predicate over one configured refspec value.
 *
 * The two halves of the grammar differ (measured, git 2.55.0): a FETCH spec
 * checks the ref-name format of both sides and refuses a colon-free pattern; a
 * PUSH spec checks its source only when that source is a pattern — anything
 * else may be an extended object name — and refuses an EMPTY destination that
 * fetch accepts. A negative refspec carries a source alone on both sides.
 */

import { isSafeRefName } from '../../../domain/refs/ref-validation.js';

const NEGATIVE_PREFIX = '^';
const FORCE_PREFIX = '+';
const STAR = '*';
/**
 * A character `check_refname_format` always accepts, standing in for the one
 * `*` a pattern side may carry: git's own check skips that byte and applies
 * every other rule to the name around it, which is exactly what substituting
 * an ordinary character reproduces.
 */
const PATTERN_PLACEHOLDER = 'x';

/** One refspec split the way `parse_refspec` splits it: the force/negative
 *  marker stripped, then the LAST colon, as git's own reverse search takes it. */
interface RefspecSides {
  readonly negative: boolean;
  readonly src: string;
  /** `undefined` when the spec carries no colon at all — not the same as empty. */
  readonly dst: string | undefined;
}

const splitSides = (spec: string): RefspecSides => {
  const negative = spec.startsWith(NEGATIVE_PREFIX);
  const body = negative || spec.startsWith(FORCE_PREFIX) ? spec.slice(1) : spec;
  const colon = body.lastIndexOf(':');
  if (colon === -1) return { negative, src: body, dst: undefined };
  return { negative, src: body.slice(0, colon), dst: body.slice(colon + 1) };
};

/** git's `check_refname_format(side, REFNAME_ALLOW_ONELEVEL | pattern)`: a
 *  pattern side may carry exactly one `*`, and the name is otherwise an
 *  ordinary one-level-or-deeper ref name. */
const isRefspecSide = (side: string, pattern: boolean): boolean => {
  const stars = side.split(STAR).length - 1;
  if (stars > (pattern ? 1 : 0)) return false;
  return isSafeRefName(side.replace(STAR, PATTERN_PLACEHOLDER));
};

/**
 * git's `is_glob` for one spec, or `undefined` when the two sides disagree and
 * the whole spec is refused for it. A source pattern demands a destination
 * pattern, a destination pattern demands a source pattern, and a FETCH spec
 * additionally refuses a source pattern with no destination at all.
 */
const patternFlag = (src: string, dst: string | undefined, fetch: boolean): boolean | undefined => {
  const dstIsPattern = dst !== undefined && dst.includes(STAR);
  if (src.includes(STAR)) {
    if (dst === undefined) return fetch ? undefined : true;
    return dstIsPattern ? true : undefined;
  }
  return dstIsPattern ? undefined : false;
};

/** git's fetch arm: an empty source stands for `HEAD` and an empty or missing
 *  destination for "do not store"; everything else must look like a ref. */
const fetchSidesValid = (src: string, dst: string | undefined, pattern: boolean): boolean => {
  if (src !== '' && !isRefspecSide(src, pattern)) return false;
  if (dst === undefined || dst === '') return true;
  return isRefspecSide(dst, pattern);
};

/** git's push arm: the source is checked only when it is a pattern (otherwise
 *  it may be any extended object name), a missing destination puts the source
 *  under the same check instead, and an empty destination is refused outright. */
const pushSidesValid = (src: string, dst: string | undefined, pattern: boolean): boolean => {
  // Stryker disable next-line StringLiteral: equivalent — the guard only decides when `pattern` holds, and `patternFlag` sets that only for a source carrying a `*`, so the source is never the empty string nor any other star-free literal here.
  if (src !== '' && pattern && !isRefspecSide(src, true)) return false;
  if (dst === undefined) return isRefspecSide(src, pattern);
  // Stryker disable next-line StringLiteral: equivalent — `isRefspecSide` already refuses the empty string and every literal carrying a space, so the conjunction is false for both literals whichever one the comparison names.
  return dst !== '' && isRefspecSide(dst, pattern);
};

const isValidRefspec = (spec: string, fetch: boolean): boolean => {
  const { negative, src, dst } = splitSides(spec);
  if (negative) return dst === undefined && isRefspecSide(src, true);
  const pattern = patternFlag(src, dst, fetch);
  if (pattern === undefined) return false;
  return fetch ? fetchSidesValid(src, dst, pattern) : pushSidesValid(src, dst, pattern);
};

/** Whether `remote.<name>.fetch` would survive git's own remote-table build. */
export const isValidFetchRefspec = (spec: string): boolean => isValidRefspec(spec, true);

/** Whether `remote.<name>.push` would survive git's own remote-table build. */
export const isValidPushRefspec = (spec: string): boolean => isValidRefspec(spec, false);
