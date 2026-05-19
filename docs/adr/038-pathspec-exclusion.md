# ADR-038: Pathspec exclusion via `!` prefix, last-match-wins

## Status

Accepted (at `49a147e`)

## Context

Real-world pathspec calls often want to express "include this set
except for that subset" — `add('*.ts', '!*.test.ts')`. Options:

1. **`!` prefix, last-match-wins**: mirrors `.gitignore` semantics
   (already shipped in §14.3) and Git's own pathspec exclusion
   (`:!*.test.ts` / `:^*.test.ts` / `git add '*.ts' ':!*.test.ts'`).
2. **No exclusion** — users filter manually with two calls.

Option 2 forces a callers-write-it-themselves workflow: build the set
of paths via the pathspec, then filter them. For `add`, this means
walking the working tree once to enumerate `.ts`, then filtering
client-side, then calling `add` per-path. The library can compose
this in one call.

The `.gitignore` matcher's `matches()` returns a tri-state
('ignored' / 'unignored' / 'unset'); pathspec is binary
(matched / not matched). The "last match wins" semantics translate
cleanly: a `!`-prefixed entry that matches resets the verdict to
"not matched"; a non-negated entry that matches sets it back.
Starting state is "not matched" — a spec with ONLY negations is a
no-op.

## Decision

Adopt option 1. `compilePathspec` strips a leading `!` from each
pattern and sets `negated: true`. `matchesPathspec` iterates the
entries in order; the last match (positive or negative) determines
the boolean verdict. Starting state is `false`.

## Consequences

### Positive

- Aligns with `.gitignore` mental model — users already shipped on
  §14.3 don't have to learn a second pathspec rule set.
- Closes a common workflow case (`add '*.ts' '!*.test.ts'`) in one
  call.
- Maps directly to Git's `:!` pathspec without supporting the magic
  prefix surface (deferred — see ADR-037).

### Negative

- A literal pattern starting with `!` cannot be expressed without an
  escape. Same caveat as ADR-037; future magic-prefix support can
  add `:(literal)!foo` if a user needs this.
- All-negation pathspecs (`['!*.test.ts']`) silently match nothing.
  Callers writing this likely intended `['*', '!*.test.ts']`; we
  could throw on all-negation, but matching nothing is the principled
  fallout of the semantics. Documented.

### Neutral

- `!` parsing happens BEFORE `validateWorkingTreePath`. The body
  (post-`!`) is what gets validated, so `!../escape` is rejected on
  the `..` segment regardless of negation.
