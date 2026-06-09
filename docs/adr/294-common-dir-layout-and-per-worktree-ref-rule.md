# ADR-294: `commonDir` on the repository layout + the per-worktree-ref rule

## Status

Accepted (at `d346826a3c11535a5915627d30613870a69961d0`)

## Context

A linked working tree (`git worktree add`) shares the main repository's object
store and shared refs but keeps its own `HEAD` / `index` / per-worktree state in
an admin directory `<commonDir>/worktrees/<id>/`. tsgit's `RepositoryLayout` has
a single `gitDir`, and every object/ref/config/reflog primitive keys off it.

A faithful, materialising `worktree add` (and a dirty-checking `remove` that
reuses `status`) needs a Context whose **objects** resolve from the shared store
while its **index/HEAD** live in the admin dir. With one `gitDir` that is
impossible — objects would be sought in `<adminDir>/objects` (absent).

Options weighed:

1. **`commonDir` on the layout (optional, defaults to `gitDir`)**, consumed by
   the object/shared-ref/config/reflog paths; per-worktree state stays on
   `gitDir`. Selection between the two is git's own per-worktree-ref rule.
2. A bespoke index-path/HEAD-path override on the child Context (inverted model:
   `gitDir` = shared, separate fields for the per-worktree files). Same
   information, but inverts git's mental model (git: `gitDir` = the per-worktree
   admin dir, `commonDir` = shared) and scatters overrides.
3. Symlink/copy the shared `objects` into each admin dir. Unfaithful (git does
   not), wastes space, breaks gc.

## Decision

Add `commonDir?: string` to `RepositoryLayout`. Resolve it everywhere through
one helper, `commonGitDir(ctx) = ctx.layout.commonDir ?? ctx.layout.gitDir`, so
**every existing repository (main worktree, normal, bare) is byte-for-byte
unchanged** — only a worktree child Context sets `commonDir`.

Thread `commonGitDir` through the **shared** state — objects (`object-resolver`,
`pack-registry`, `resolve-oid-prefix`), `packed-refs` + `config`
(`config-read`/`config-scope`), `info/exclude` (`read-gitignore`), and shared
refs/reflogs (`ref-store`/`reflog-store`). Keep **per-worktree** state on
`gitDir` — `HEAD`, `ORIG_HEAD`, `index` (`read-index`/`index-lock` unchanged),
`logs/HEAD`, and per-worktree refs.

The loose-ref / reflog split is a pure predicate `isPerWorktreeRef(name)`
porting git's `is_per_worktree_ref` + pseudoref set: `HEAD`, `ORIG_HEAD`,
`MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_HEAD`, `FETCH_HEAD`,
and any ref under `refs/bisect/`, `refs/worktree/`, `refs/rewritten/`.

## Consequences

### Positive

- A worktree child Context behaves like a real linked worktree with no
  per-call-site special-casing.
- Zero behaviour change for existing repos (default-to-`gitDir`), so the large
  threaded diff is a mechanical, behaviour-preserving refactor outside the
  worktree paths.
- Lays the groundwork for a future `openRepository(<linked-worktree-path>)`
  discovery (ADR-296) — the resolution layer already understands the split.

### Negative

- The threaded set is broad (objects + refs + config + gitignore + reflog),
  enlarging the diff and the mutation surface.

### Neutral

- `index`/`index-lock` deliberately stay `gitDir`-keyed; the index is
  per-worktree, so no thread is needed there.
