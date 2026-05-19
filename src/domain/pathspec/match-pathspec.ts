import type { FilePath } from '../objects/object-id.js';
import type { Pathspec } from './compile-pathspec.js';

// True iff `path` is selected by `spec`. Entries are evaluated in order;
// each entry's regex is tested against the path; a positive (non-negated)
// match sets the verdict to `true`, a negated match sets it to `false`.
// The last match wins. Starting state is `false` — a spec with only
// negations matches nothing.
//
// `_isDir` is reserved for future expansion (pathspec rules don't
// currently distinguish directory-only vs file matches the way
// `.gitignore` does).
//
// See docs/adr/038-pathspec-exclusion.md.
export const matchesPathspec = (
  spec: Pathspec,
  path: FilePath,
  // biome-ignore lint/correctness/noUnusedFunctionParameters: reserved for future use
  _isDir: boolean,
): boolean => {
  let matched = false;
  for (const entry of spec) {
    if (entry.compiled.test(path)) {
      matched = !entry.negated;
    }
  }
  return matched;
};
