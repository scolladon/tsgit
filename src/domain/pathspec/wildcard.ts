/**
 * Pathspec wildcard matching, git's way: a body first matches the path
 * verbatim (itself or a leading directory), then through `wildmatch` with
 * flags 0 over the path's raw bytes.
 */
import { encodeEscaped } from '../objects/encoding.js';
import { compileRefGlobBytes } from '../refs/ref-glob.js';
import type { GlobMatcher } from './compile-glob.js';

const SLASH = '/';
const GLOB_SPECIAL = /[*?[\\]/;

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

/** A wildcard body matches verbatim first, else by `wildmatch` over the path's raw bytes. */
export const compileWildcard = (body: string): GlobMatcher => {
  const wild = compileRefGlobBytes(body);
  return {
    test: (path) => verbatimLevel(body, path) !== MATCH_LEVEL.NONE || wild(encodeEscaped(path)),
  };
};
