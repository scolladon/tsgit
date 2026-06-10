import type { AttributeValue } from './attribute-value.js';

/** git's `DEFAULT_CONFLICT_MARKER_SIZE` — the fallback marker length. */
export const DEFAULT_CONFLICT_MARKER_SIZE = 7;

const INT_MAX = 2147483647;

/**
 * git's `strtol_i`: a full-string base-10 integer (optional sign), rejected when
 * it carries trailing garbage or overflows a 32-bit `int`. Only the positive
 * `INT_MAX` ceiling is checked — like git, a parsed negative is returned as-is
 * and clamped later by the `> 0` rule, so a value below the minimum reaches the
 * same default. The gitattributes parser strips surrounding whitespace, so none
 * can reach here.
 */
const strtolI = (raw: string): number | undefined => {
  if (!/^[+-]?[0-9]+$/.test(raw)) return undefined;
  const value = Number(raw);
  return value > INT_MAX ? undefined : value;
};

/**
 * The conflict-marker length for a path, from its resolved `conflict-marker-size`
 * attribute. A `strtol_i`-parsed integer strictly greater than 0 wins; every
 * other state (`0`, negative, unparseable, overflow, a bare-set/unset/unspecified
 * attribute) falls back to git's default 7.
 */
export const resolveMarkerSize = (value: AttributeValue): number => {
  if (typeof value !== 'object') return DEFAULT_CONFLICT_MARKER_SIZE;
  const parsed = strtolI(value.set);
  return parsed !== undefined && parsed > 0 ? parsed : DEFAULT_CONFLICT_MARKER_SIZE;
};
