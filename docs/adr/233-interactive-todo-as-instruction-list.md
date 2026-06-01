# ADR-233: interactive rebase todo is supplied as a `RebaseInstruction[]` data list

## Status

Accepted (at `2e17819f`)

## Context

`git rebase -i` computes a default `pick`-everything todo, opens `$EDITOR` on it,
and reads the user-edited result back. tsgit is a library with **no `$EDITOR`**,
so the edited todo must reach the command as data. Three shapes were surfaced:

1. **Inline instruction list** — `run({ upstream, onto?, interactive:
   RebaseInstruction[] })`; the array *is* the post-editor todo.
2. **Editor callback** — `run({ …, editTodo: (defaultTodo) => instructions })`;
   tsgit builds the default todo and hands it to a caller transform.
3. **Stop-based two-call** — `run` returns the default todo and stops; a second
   call applies the edited todo.

The prime directive (ADR-226) binds *observable git state* — reflogs, object
SHAs, on-disk `.git/rebase-merge/`. The editor interaction itself is not
observable state (it is host UI), so the input shape is a free design choice; it
must only feed the engine the same data git's editor parse produces.

## Decision

**Option 1 — inline instruction list.** `run` gains an optional
`interactive?: ReadonlyArray<RebaseInstruction>` field; its **presence** selects
the interactive engine, its absence keeps the 22.3 non-interactive path
byte-for-byte unchanged.

```ts
type RebaseInteractiveAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';
interface RebaseInstruction {
  readonly action: RebaseInteractiveAction;
  readonly oid: string;        // commit-ish in the onto..HEAD range
  readonly message?: string;   // reword/squash only (ADR-234)
}
```

This mirrors the established `cherryPick.run({ commits })` / `revert.run({
commits })` idiom (named-field input mirroring the CLI), is purely declarative
(no function in the public surface), and is trivial to unit-test and to drive
from interop fixtures. Caller-side invariants git's editor parse enforces
(every oid in range, no leading squash/fixup, non-empty) are validated up front
as refusals (`INVALID_OPTION`) before any state change.

## Consequences

### Positive

- One declarative call; matches the four sibling history-rewrite namespaces.
- No callback/continuation in the public API; deterministic and serialisable.
- Non-interactive callers are unaffected (additive optional field).

### Negative

- The caller must resolve/spell out the full todo up front rather than mutating
  a tsgit-provided default; a convenience "default todo" builder may be a later
  follow-up.

### Neutral

- Reordering, dropping, and re-verbing are expressed by the list's contents and
  order, exactly as the edited todo would be.
