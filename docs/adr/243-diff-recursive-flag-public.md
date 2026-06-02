# ADR-243: `diff` exposes a public `recursive` flag; patch always recurses

## Status

Accepted (at `f9a13020`)

## Context

`repo.diff({ format: 'patch' })` throws `UNEXPECTED_OBJECT_TYPE` on any tree
containing a sub-directory: the single-level tree-diff classifies a sub-tree as a
plain change carrying a *tree* oid, and the patch materialiser then `readBlob`s
that tree. The fix is a shared recursive tree-diff (flatten both trees to
full-path blobs, then classify) adopted by the patch path.

`git` splits diff into two surfaces:

- **`git diff` (porcelain)** — always recursive; a sub-directory change renders as
  per-file hunks. tsgit's `diff({ format: 'patch' })` is the analogue.
- **`git diff-tree` (plumbing)** — non-recursive by default; `-r` opts in to
  recursion. tsgit's structured `diff({ format: 'tree' })` is the analogue.

The patch path *must* recurse (that is the bug). The open question is whether the
structured `tree` format should recurse, and whether recursion is a public knob.
Three options were weighed:

- **A** — patch recurses unconditionally; `tree` stays single-level; no public
  flag (recursion only on the internal primitive).
- **B** — patch recurses unconditionally; add a public `recursive?: boolean` to
  `DiffOptions` (default `false`) that opts the `tree` format into recursion,
  mirroring `git diff-tree -r`.
- **C** — both formats always recurse (no flag), diverging from `git diff-tree`'s
  non-recursive default.

## Decision

**Option B.** Add a public `recursive?: boolean` to `DiffOptions`, defaulting to
`false`.

- `format: 'patch'` **always recurses**, irrespective of `recursive` (git's
  porcelain has no non-recursive patch). The flag is a no-op for patch.
- `format: 'tree'` recurses **only** when `recursive: true`, reproducing
  `git diff-tree` (default) / `git diff-tree -r` (opt-in). Default `false`
  preserves the existing single-level structured contract.

Internally this is one composition: `recursive = format === 'patch' || opts.recursive === true`,
threaded to the `diffTrees` primitive's own `recursive` option.

## Consequences

### Positive

- Fixes the patch throw and gives plumbing consumers `git diff-tree -r`-equivalent
  per-file granularity on demand.
- Faithful to git's porcelain-always-recursive / plumbing-opt-in split.
- `format: 'tree'` default behaviour is unchanged — no silent break for existing
  structured-diff consumers.

### Negative

- Grows the public `DiffOptions` surface by one optional field (additive,
  non-breaking; requires an `api.json` regen).
- `recursive` is inert for `format: 'patch'` — a caller passing
  `{ format: 'patch', recursive: false }` still gets a recursive patch. Mirrors
  git (no `git diff --no-recursive`); documented on the option.

### Neutral

- The internal `DiffTreesOptions.recursive` primitive flag is the shared
  mechanism behind both this public flag and the always-on patch/`show`/`patch-id`
  recursion.
