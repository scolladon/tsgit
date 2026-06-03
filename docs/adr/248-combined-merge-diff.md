# ADR-248: full combined merge diff — dense default fixes the latent merge bug

## Status

Accepted (at `4492407b`)

## Context

Research for 23.1b surfaced that `git show <merge>` defaults to a **dense
combined diff** (`--cc`), not "no patch". 23.1's design claim ("merge commits
show no patch — git's default") held only because its single interop fixture was
a *trivial* merge (result identical to one parent → empty combined diff). For a
merge that combined changes from both sides, current `show` emits the wrong
bytes (header + trailing blank, no diff; git emits `diff --cc`). So combined-diff
support is not purely additive — it closes a latent default-merge bug.

Combined diff (`combine-diff.c`) is git's most intricate diff format:
per-parent column prefixes, `@@@ … @@@` N+1 hunk headers, and the dense
(`--cc`) pruning that drops single-parent hunks. Options weighed:

- **A — `-m` only, defer combined.** Per-parent diffs (reuse pairwise
  `diffTrees`); refuse `-c`/`--cc`, keep the (buggy) no-patch default. Smallest,
  but leaves the default-merge bug open.
- **B — full combined, 2-parent only.** Port combine-diff for 2 parents; refuse
  octopus.
- **C — full combined incl. octopus.** Port the general N-parent algorithm; fix
  the default-merge path to emit dense combined.

## Decision

**Option C** (user-selected). Port `combine-diff.c` for the general N-parent
case and make `dense` (`--cc`) the merge default, plus `-m` (separate per-parent)
and `-c` (non-dense combined):

1. Per parent `i`, line-diff `Pi` vs result `R`; insertions set
   `sline.flag |= 1<<i`, deletions attach `lost` lines tagged `i`.
2. `interesting = (flag & all) || lost`; grow `context` (3) lines into hunks;
   merge adjacent.
3. **dense**: drop any hunk whose every change is attributable to a single
   parent (the merge took it verbatim from one side) — this also drops files
   identical to a parent, reproducing the trivial-merge "no patch".
4. Render `diff --cc`/`--combined`, `index <p0>,<p1>..<R>`, `@@@` hunks, `N`
   per-parent prefix columns.

An empty combined diff renders header + trailing blank — byte-identical to
today's trivial-merge output, so the existing interop case keeps passing.
`mergeDiff` default is `dense`; `none` (`-s`) suppresses it.

## Consequences

### Positive

- Default `git show <merge>` becomes byte-faithful for *all* merges, closing the
  23.1 latent bug; `-m`/`-c`/`--cc` all available.
- One combined-diff domain module, reused by any future combined-diff consumer
  (`log -c`, `diff-tree -c`).

### Negative

- The single largest, highest-risk module in the item; byte-exactness of dense
  pruning and `@@@` ranges rests heavily on the interop goldens (non-trivial
  merge + octopus).

### Neutral

- Builds on the existing `diffLines` engine — no new line-diff algorithm.
- Octopus combined diff is exercised by a dedicated interop fixture.
