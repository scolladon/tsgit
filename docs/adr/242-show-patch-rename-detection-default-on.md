# ADR-242: `show` commit patches detect renames by default

## Status

Accepted (at `74395be8`)

## Context

The commit patch `git show` prints honours `diff.renames`, which has defaulted
to `true` since git 2.9. With no config (scrubbed `GIT_*`, empty global/system
config), `git show` of a rename commit emits:

```
diff --git a/a.txt b/renamed.txt
similarity index 100%
rename from a.txt
rename to renamed.txt
```

The sibling `diff` command in this library defaults `detectRenames` to **false**
(rename detection is opt-in via `repo.diff({ detectRenames: true })`), because
`diff`'s structured `TreeDiff` consumers historically wanted the raw
add/delete decomposition.

So `show`'s patch and `diff`'s default disagree on rename detection. One of
them must give to stay faithful to its respective git command.

## Decision

`show` computes its commit patch with **rename detection on**:

```ts
diffTrees(ctx, parentTree?, commitTree, { detectRenames: true })
```

This matches default `git show` / `git log` (which honour `diff.renames=true`).
The `diff` command keeps its opt-in default unchanged — `git diff` and
`git show` are different porcelain with different observed defaults, so the two
library commands faithfully diverge from *each other* precisely because each
mirrors its own git counterpart.

`show` does not expose a knob to turn detection off in v1 (`--no-renames` is
deferred); the faithful default is the only behaviour.

## Consequences

### Positive

- `show`'s patch byte-matches default `git show` for renames (`similarity
  index` / `rename from` / `rename to`) — pinned by interop.
- Each command honours the prime directive against its *own* git command
  rather than against the other library command.

### Negative

- A reader comparing `repo.show(c).patch.diff` with `repo.diff({from,to})` sees
  different change shapes (rename vs delete+add) for the same trees. Documented;
  it reflects the genuine git default split.

### Neutral

- Rename detection reuses the existing `detectRenames` machinery (50%-similarity
  inexact + exact), so no new code; only the default flag differs.
- `--no-renames` / `-M<n>` tuning remains an additive option on `ShowOptions`.
