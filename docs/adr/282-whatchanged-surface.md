# ADR-282: `whatchanged` surface — separate command, exclude merges, `extends LogEntry`

## Status

Accepted (at `b1170eb4`)

## Context

Backlog 23.7 adds `whatchanged` — git's `git whatchanged`, which in modern git
(2.54) is an exact alias for `git log --raw --no-merges`. tsgit returns
structured data only (ADR-249), so the `--raw` rendering is a caller concern;
what the library must decide is the command's *data* surface. Three load-bearing
choices, none pre-decided by an existing ADR:

1. **Where does it live** — a distinct command, or a `log` option?
2. **Merge handling** — git excludes merges from `whatchanged` output by default.
   Do we stop there, or also offer the `-m` per-parent inclusion now?
3. **Entry shape** — how each commit + its changes is projected.

The per-commit diff (first-parent, recursive, renames-on) is already pinned by
faithfulness research against real git and matches `show`'s single-parent diff
(ADR-242); it is not in question here.

## Decision

1. **A distinct Tier-1 command** `repo.whatchanged(opts?)`, not a `log` option.
   It follows the per-command precedent of the other Phase-23 inspection
   surfaces (`shortlog`, `range-diff`), matches git's command surface, and its
   `--no-merges` default is a genuinely different result set than `log` — folding
   it into `log` would muddy `log`'s lean commit projection.

2. **Exclude merges only, for v1.** Commits with ≥2 parents are filtered from the
   output (faithful to `git log --raw --no-merges`); they are still traversed for
   reachability, so side-branch commits still appear. Each emitted entry carries
   exactly one `changes: TreeDiff` against its first parent (root → empty tree).
   The `-m` / `-c` per-parent / combined merge diffs are **deferred** — they are
   already reachable through `show`, and adding them would widen `changes` to a
   single-vs-per-parent union before there is a consumer for it.

3. **`WhatchangedEntry extends LogEntry` + `changes: TreeDiff`.** The entry reuses
   `log`'s flat commit projection (`id` / `tree` / `parents` / `author` /
   `committer` / `message`) verbatim and adds the structured changes. The commit
   fields stay in lockstep with `log` by construction; rejected alternatives were
   reusing `show`'s `ShowCommitResult` union (nests the commit data differently
   from `log` and carries a redundant `kind` tag) and a nested `{ commit, changes
   }` (an extra access level for every field). `WhatchangedOptions` is a
   standalone interface mirroring `log`'s walk knobs (`rev` / `order` / `limit` /
   `excluding` / `before`) — **not** a reuse of `LogOptions`, so a future
   `log`-only option (e.g. a pathspec filter) does not silently leak in.

## Consequences

### Positive

- Faithful to `git whatchanged`'s observable data behaviour; the raw rendering is
  reconstructed in the interop test from the structured `changes`, not emitted.
- Minimal new code — composes `walkCommitsByDate` / `walkCommits`, `resolveCommit`,
  and `diffTrees`; no new domain module or primitive.
- The commit projection cannot drift from `log` (shared base type).
- The shared "changes a commit introduced vs its first parent" diff (today
  private to `show`) gets a second consumer, motivating a clean extraction in the
  architecture pass.

### Negative

- `-m` / `-c` merge diffs and pathspec filtering are not available on
  `whatchanged` in v1 (documented non-goals; `show` covers merge diffs).
- `WhatchangedEntry extends LogEntry` couples the two entry types — a deliberate
  lockstep, but a `log` entry-field change is now also a `whatchanged` change.

### Neutral

- Adds one Tier-1 command (35 → 36): facade key, doc page + index row, api.json,
  interop + parity scenario.
- `whatchanged`'s options structurally equal `log`'s today; the standalone
  interface is forward-looking insurance, not a current divergence.
