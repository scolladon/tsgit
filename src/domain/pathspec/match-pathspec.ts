import type { FilePath } from '../objects/object-id.js';
import type { Pathspec, PathspecEntry } from './compile-pathspec.js';
import { MATCH_LEVEL, type MatchLevel, verbatimLevel } from './wildcard.js';

// True iff `path` is selected by `spec`. Entries are evaluated in order;
// each entry's regex is tested against the path; a positive (non-negated)
// match sets the verdict to `true`, a negated match sets it to `false`.
// The last match wins. Starting state is `false` — a spec with only
// negations matches nothing.
//
// See docs/adr/038-pathspec-exclusion.md.
export const matchesPathspec = (spec: Pathspec, path: FilePath): boolean => {
  let matched = false;
  for (const entry of spec) {
    if (entry.compiled.test(path)) {
      matched = !entry.negated;
    }
  }
  return matched;
};

// The elements that do not name `path` exactly: a literal whose body is `path`.
export const withoutExactly = (spec: Pathspec, path: FilePath): Pathspec =>
  spec.filter((entry) => !(entry.isLiteral && entry.body === path));

const CONFLICTED_ENTRY_COUNT = 2;

// git's verdict for a path held at `entryCount` index entries: a conflicted
// path stays selected when only an exact exclusion would have removed it.
export const matchesUnmergedPath = (spec: Pathspec, path: FilePath, entryCount: number): boolean =>
  matchesPathspec(spec, path) ||
  (entryCount >= CONFLICTED_ENTRY_COUNT && matchesPathspec(withoutExactly(spec, path), path));

// How strongly one entry reaches `path`, ignoring negation (callers pass
// positives): the verbatim level when the body names or contains it, FNMATCH
// when only the wildcard dialect selects it.
export const pathspecMatchLevel = (entry: PathspecEntry, path: FilePath): MatchLevel => {
  const verbatim = verbatimLevel(entry.body, path);
  if (verbatim !== MATCH_LEVEL.NONE) return verbatim;
  return entry.compiled.test(path) ? MATCH_LEVEL.FNMATCH : MATCH_LEVEL.NONE;
};
