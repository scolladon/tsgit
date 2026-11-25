/**
 * The ref-glob dialect `gc.<pattern>.*` and `name-rev`'s `--refs`/`--exclude`
 * share: git's `wildmatch(pattern, ref, 0)` — `*` and `?` cross `/` (no
 * `WM_PATHNAME`). The `WM_PATHNAME` variant (`merge.suppressDest`) keeps `*`,
 * `?` and `[…]` inside one `/`-separated segment and lets only a whole-segment
 * `**` cross it. The matcher itself lives in `../glob/wildmatch.ts`.
 */

import {
  matchWildmatch,
  PATHNAME_FLAGS,
  REF_FLAGS,
  tokenizeWildmatch,
  type WildmatchFlags,
} from '../glob/wildmatch.js';
import { encode } from '../objects/encoding.js';

const compileBytesWith = (
  pattern: string,
  flags: WildmatchFlags,
): ((text: Uint8Array) => boolean) => {
  const tokens = tokenizeWildmatch(encode(pattern), flags);
  if (tokens === undefined) return () => false;
  return (text: Uint8Array): boolean => matchWildmatch(tokens, text);
};

const compileWith = (pattern: string, flags: WildmatchFlags): ((text: string) => boolean) => {
  const matchBytes = compileBytesWith(pattern, flags);
  return (text: string): boolean => matchBytes(encode(text));
};

/** {@link compileRefGlob} over raw bytes: for text that is not valid UTF-8, where
 *  a string round-trip would lose the bytes `wildmatch` compares. */
export const compileRefGlobBytes = (pattern: string): ((text: Uint8Array) => boolean) =>
  compileBytesWith(pattern, REF_FLAGS);

/** Compiles `pattern` once into a matcher `wildmatch(pattern, ref, 0)`
 *  agrees with byte-for-byte — full match, case-sensitive, `*`/`?` crossing
 *  `/`. Reuse the returned function across many refs instead of recompiling. */
export const compileRefGlob = (pattern: string): ((ref: string) => boolean) =>
  compileWith(pattern, REF_FLAGS);

/** Compiles `pattern` into a matcher `wildmatch(pattern, text, WM_PATHNAME)`
 *  agrees with — `*`, `?` and `[…]` stay within one `/`-separated segment,
 *  a whole-segment `**` crosses them (`merge.suppressDest`). */
export const compilePathnameGlob = (pattern: string): ((text: string) => boolean) =>
  compileWith(pattern, PATHNAME_FLAGS);

/** One-shot form of {@link compileRefGlob} for a single ref check. */
export const matchRefGlob = (pattern: string, ref: string): boolean => compileRefGlob(pattern)(ref);
