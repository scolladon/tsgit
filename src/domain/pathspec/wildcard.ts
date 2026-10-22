/**
 * Pathspec wildcard matching, git's way: a body first matches the path
 * verbatim (itself or a leading directory), then through `wildmatch` with
 * flags 0 over the path's raw bytes.
 */
import { encodeEscaped } from '../objects/encoding.js';
import { compileRefGlobBytes } from '../refs/ref-glob.js';
import type { GlobMatcher } from './compile-glob.js';

const SLASH = '/';
const STAR = '*';
const GLOB_SPECIAL = /[*?[\\]/;
const GLOB_SPECIAL_GLOBAL = /[*?[\\]/g;

/** Ordered as git orders its match levels, so a caller can take the maximum. */
export const MATCH_LEVEL = { NONE: 0, RECURSIVE: 1, FNMATCH: 2, EXACT: 3 } as const;
export type MatchLevel = (typeof MATCH_LEVEL)[keyof typeof MATCH_LEVEL];

/** True when the body holds a character git treats as a wildcard: `*`, `?`, `[` or `\`. */
export const hasGlobSpecial = (body: string): boolean => GLOB_SPECIAL.test(body);

/** How `body` names `path` literally: the path itself, a directory above it, or neither. */
export const verbatimLevel = (body: string, path: string): MatchLevel => {
  if (body === '') return MATCH_LEVEL.RECURSIVE;
  if (!path.startsWith(body)) return MATCH_LEVEL.NONE;
  if (path.length === body.length) return MATCH_LEVEL.EXACT;
  if (body.endsWith(SLASH) || path[body.length] === SLASH) return MATCH_LEVEL.RECURSIVE;
  return MATCH_LEVEL.NONE;
};

export type WildcardShape =
  | { readonly kind: 'one-star'; readonly prefix: string; readonly suffix: string }
  | { readonly kind: 'general'; readonly literalPrefix: string };

/** Splits a body into what string compares can decide (`prefix*suffix`) or its literal head. */
export const wildcardShape = (body: string): WildcardShape => {
  const specials = body.match(GLOB_SPECIAL_GLOBAL) ?? [];
  const first = body.search(GLOB_SPECIAL);
  if (specials.length === 1 && specials[0] === STAR) {
    return { kind: 'one-star', prefix: body.slice(0, first), suffix: body.slice(first + 1) };
  }
  return { kind: 'general', literalPrefix: first < 0 ? body : body.slice(0, first) };
};

/** `prefix*suffix` over strings: both ends must fit without overlapping, as the byte DP requires. */
export const oneStarMatches = (prefix: string, suffix: string, path: string): boolean =>
  path.length >= prefix.length + suffix.length && path.startsWith(prefix) && path.endsWith(suffix);

/** A wildcard body matches verbatim first, else by `wildmatch` over the path's raw bytes. */
export const compileWildcard = (body: string): GlobMatcher => {
  const shape = wildcardShape(body);
  const wild = compileRefGlobBytes(body);
  const wildmatch = (path: string): boolean =>
    shape.kind === 'one-star'
      ? oneStarMatches(shape.prefix, shape.suffix, path)
      : path.startsWith(shape.literalPrefix) && wild(encodeEscaped(path));
  return { test: (path) => verbatimLevel(body, path) !== MATCH_LEVEL.NONE || wildmatch(path) };
};
