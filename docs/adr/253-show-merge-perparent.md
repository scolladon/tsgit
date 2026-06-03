# ADR-253: `show` on a merge carries `perParent` diffs

## Status

Accepted (at `010cdce1`)

## Context

`git show <merge>` defaults to a **combined** diff (`--cc`): lines differing from
*both* parents. tsgit's combined diff (ADR-248) exists only as reconstructed *text*
— there is no structured combined-diff type in the domain. Under the structured-only
rule (ADR-250) a text-only artifact cannot be a library return value, so the merge
case needs a structured shape.

Three shapes were weighed for what `show` returns on a merge:

1. **`perParent`** — single-parent/root commit keeps `patch?: TreeDiff`; a merge
   fans out to `perParent: ReadonlyArray<TreeDiff>` (one per parent).
2. **Unified `parents[]`** — every commit carries `parents: [{ parent, diff }]`
   (normal = length 1, root = 0, merge = N).
3. **No patch on merges** — merge carries commit data only; caller diffs parents.

The deciding factor was consumer ergonomics for the dominant task ("what did this
commit change?"). Option 2 taxes *every* caller — even for an ordinary one-parent
commit — with array indexing plus a root-commit empty-array edge case, and
duplicates the oids already on `CommitData.parents` (a DRY smell). Option 3 forces
extra `diff()` round-trips for merges and is surprising (a diff for normal commits,
silence for merges). Option 1 keeps the 99 % single-parent path a one-field access
and mirrors git's own `default` vs `-m` modes.

## Decision

```ts
type ShowResult =
  | { kind:'commit'; id; commit: CommitData; patch?: TreeDiff }                  // 0–1 parent
  | { kind:'commit'; id; commit: CommitData; perParent: ReadonlyArray<TreeDiff> } // ≥2 parents
  | …;
```

- A **root or single-parent** commit carries `patch?: TreeDiff` (diff against the
  empty tree / the lone parent; absent only if there is no diff to compute).
- A **merge** (≥2 parents) carries `perParent`, one `TreeDiff` per parent in parent
  order; no `patch`.
- Each `TreeDiff` (single or per-parent) honors `withStat` (ADR-252) identically.

git's textual combined diff is **not** a library return value; the interop test
reconstructs the `--cc` bytes from the parent trees + the merge tree and compares to
real `git show <merge>`, preserving the combined-diff algorithm as test-only
reconstruction.

## Consequences

### Positive

- Dominant single-parent path is one field access; merge data is available without
  extra round-trips.
- Mirrors git's `show` (default) vs `-m` mental model; no surprise.
- No oid duplication with `CommitData.parents`.

### Negative

- Two fields (`patch` vs `perParent`) rather than one; generic "any commit" code
  branches on `commit.parents.length >= 2` (or field presence).

### Neutral

- The combined-diff *algorithm* (ADR-248) is retained as interop-test reconstruction,
  not a library surface. Supersedes ADR-248's structured exposure expectation for
  merges.
