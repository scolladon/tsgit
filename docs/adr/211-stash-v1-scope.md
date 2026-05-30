# ADR-211: `stash` v1 scope — verbs, flags, and deferrals

## Status

Accepted (at `5fa805d6`)

## Context

`git stash` is a large surface: five core verbs plus patch mode, pathspec
limiting, `clear`, `branch`, `show`, `create`/`store` plumbing, and several
apply/push flags. Phase 21.3's backlog entry names `push`/`pop`/`list`/`drop`/
`apply`. We must fix what ships now versus what is deferred.

## Decision

**Ships in 21.3:**

- The five verbs: `push`, `list`, `apply`, `pop`, `drop`.
- `push` flags: custom `message` (`-m` → `On <branch>: <message>`),
  `includeUntracked` (`-u` → the U commit), `keepIndex` (`--keep-index`).
- `apply`/`pop` flag: `restoreIndex` (`--index`) — restore staged-ness on a
  clean merge.

**Deferred (out of scope, §11 of the design):**

- Patch mode (`stash -p`), pathspec-limited push (`stash push -- <paths>`).
- `stash clear`, `stash branch <name>`, `stash show`, `stash create` / `store`.
- `--index` reinstatement of a *conflicted* staged state (clean-merge only).

`push` with no local changes returns `{ kind: 'no-local-changes' }` (not an
error) — faithful to git printing the message and exiting 0.

## Consequences

### Positive

- Full common-path stash workflow lands in one phase, including `-u` which gives
  the pre-built `StashSnapshot.untracked` slot real meaning.
- Deferred items are additive later — no API breakage to add `-p`, `clear`, etc.

### Negative

- Three optional flags (`-u`, `--keep-index`, `--index`) materially enlarge the
  implementation versus a bare five-verb MVP; each needs isolated test coverage.

### Neutral

- The deferred verbs (`clear`, `branch`, `show`) are tracked for a later phase.

## Alternatives considered

1. **Bare five verbs, no optional flags** — rejected: `-u` is near-mandatory for
   the snapshot trio to be meaningful, and `--keep-index`/`--index` are common.
2. **Everything including patch/pathspec/clear/branch/show** — rejected: patch
   mode and pathspec stashing are large independent features; bundling them
   would balloon a single phase.
