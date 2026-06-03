# ADR-245: `<rev>:<path>` resolves via a new rev-parse grammar branch

## Status

Accepted (at `4492407b`)

## Context

`git show HEAD:a.txt` reads the blob at `a.txt` inside `HEAD`'s tree; `git show
HEAD:` reads the root tree. The grammar `<tree-ish>:<path>` is general git
revision syntax (`gitrevisions(7)`), used everywhere `get_oid` runs, not just in
`show`. tsgit's `revParse` already parses a *leading*-colon form
`:<stage>:<path>` (index stage). The non-leading-colon `<rev>:<path>` form is
unhandled — it currently falls through to ref/oid-prefix resolution and fails
with `OBJECT_NOT_FOUND`.

Where should the new resolution live?

- **A — extend `revParse`.** Add a `tree-path` grammar kind to the shared
  rev-parse grammar; resolve the left side to a tree, walk path components.
  Every `revParse` caller (rev-parse, diff, show, …) gains the syntax, matching
  git's "resolve everywhere" behaviour.
- **B — resolve only inside `show`.** Special-case the `:` split in `show.ts`.
  Narrower blast radius but non-faithful (git resolves `<rev>:<path>` in all
  commands) and duplicates path-walking that belongs in the rev layer.

## Decision

**Option A.** Add a `tree-path` branch to `internal/rev-parse-grammar.ts`: a
non-leading `:` (and not the `:<stage>:<path>` index form) splits
`<tree-ish>:<path>`. `revParse` resolves the left to a commit/tree, peels a
commit to its tree, and walks `path` segments through tree entries to the
addressed blob/tree oid; an empty path returns the tree itself. A missing
component raises a typed `PATH_NOT_IN_TREE` (`{ rev, path }`).

This is purely additive — inputs that resolve now previously errored — and
faithful: git accepts `<rev>:<path>` in every command, so threading it through
the shared resolver (rather than `show` alone) is the correct layer.

## Consequences

### Positive

- Faithful, repository-wide `<rev>:<path>` support from one seam; `show` renders
  the resolved blob/tree with no bespoke path logic.
- The tree header still echoes the verbatim input (`tree HEAD:sub`).

### Negative

- Touches the widely-shared `revParse`; mitigated by the change being purely
  additive (only previously-failing inputs change outcome) and covered by
  grammar unit tests + interop.

### Neutral

- Introduces one new error code (`PATH_NOT_IN_TREE`).
