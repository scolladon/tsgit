# ADR-270: working-tree `blame` is an explicit opt-in, not the omit-rev default

## Status

Accepted (at `cbae090a`)

## Context

ADR-258 deferred git's bare-`git blame <file>` working-tree behaviour (the
"Not Committed Yet" pseudo-commit) and made `repo.blame(path)` target a committed
rev (default `HEAD`), because tsgit's memory/browser adapters frequently have no
working tree. ADR-258 explicitly anticipated a follow-up that adds working-tree
blame "**without changing the committed-rev semantics decided here**," sketching
(parenthetically) a possible "default-on worktree resolution when `rev` is omitted
and a worktree exists."

Now adding working-tree blame, the selector is a fork:

- **A — omit-rev ⇒ worktree** (git-exact): `repo.blame('f')` blames the worktree.
  Breaking (today's omit-rev means HEAD); refuses on worktree-less adapters
  unless the caller passes `{ rev: 'HEAD' }`. The 23.4 breaking window makes the
  break "free now, frozen after Phase 28."
- **B — explicit opt-in**: a `worktree: true` selector; omit-rev stays HEAD.
  Non-breaking; the browser/memory surface keeps working; matches ADR-258's
  "without changing the committed-rev semantics" literally.
- **C — hybrid** (ADR-258's parenthetical): omit-rev ⇒ worktree if a worktree
  exists, else HEAD. The same call means different things per adapter — silent
  and hard to reason about.

The prime directive binds git's observable **data and on-disk state** byte-for-
byte (ADR-226), refined by ADR-249 to *not* bind the library's stdout or its
default-parameter ergonomics. So a non-git-exact *default parameter* is not a
faithfulness violation, as long as the working-tree mode, once selected, produces
byte-faithful data.

## Decision

**Option B.** Working-tree blame is an **explicit opt-in**: `BlameOptions.worktree:
true` selects the working-tree pseudo-commit; omitting it preserves today's
committed-rev semantics (default `HEAD`). `worktree: true` together with `rev` is a
nonsensical combination and is **refused** with a typed `INVALID_OPTION` (git has
no worktree flag — worktree is bare git's no-rev default, so the pair has no git
analogue to be faithful to).

Working-tree mode, when selected, is byte-faithful to bare `git blame <file>`:
uncommitted lines map to the zero-oid pseudo-commit, committed lines to their real
history, refusals co-refuse (untracked → "no such path in HEAD"; missing-on-disk →
"Cannot lstat"; unborn HEAD → "no such ref: HEAD").

## Consequences

### Positive

- Non-breaking: every existing `repo.blame(path)` / `repo.blame(path, { rev })`
  caller is unaffected.
- Adapter-safe: the browser/memory surface (no worktree by default) keeps
  returning committed-HEAD data on omit-rev — the surface ADR-258 protected.
- No adapter-capability probing inside the command; the selector is explicit data,
  not an inferred runtime branch.
- Honours ADR-258's stated constraint verbatim.

### Negative

- `repo.blame('f')` does **not** mirror bare `git blame f` (worktree) — a git user
  must opt in with `{ worktree: true }`. Documented; consistent with the library's
  structured-over-CLI house style (ADR-249).
- The 23.4 window's "git-exact omit-rev, cheaply, now" option is forgone; making
  omit-rev mean worktree later would itself be breaking.

### Neutral

- `worktree` is a tsgit-specific selector with no `git blame` flag analogue; the
  `worktree`+`rev` refusal keeps the illegal combination unrepresentable in
  practice (a guard, not a type-level union, given the two fields' different
  shapes).
- A future read-model convergence (23.4j) can re-express the selector as one more
  source without changing these semantics.
