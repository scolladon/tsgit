# ADR-241: `show` multi-revision arg list — `shown_one` separator + commit de-duplication

## Status

Accepted (at `74395be8`)

## Context

`git show A B C` resolves and renders several objects in one invocation. v1 of
`show` adopts this (rather than a single-rev-only core) so the command matches
git's surface from the start. Faithful multi-object output has two observed
rules that are *not* obvious from the single-object formats:

1. **`shown_one` separator.** git inserts one blank line **before** each
   commit / tag / tree entry once anything has already been shown — never after
   the last, never before the first. **Blobs** neither emit nor consume the
   separator (raw dump): a commit immediately following a blob gets **no**
   separator. The blank line between an annotated tag and its tagged object is
   the *same* `shown_one` separator (the tag sets the flag; the target consumes
   it), not a special case.

2. **Commit de-duplication.** `git show A B A` renders the commit `A` **once** —
   git's revision walker marks commits SHOWN and skips repeats across the whole
   arg list (and tag targets, which share the walk). Blobs, trees, and tags are
   **not** deduped (`git show <blob> <blob>` dumps it twice).

Both were verified against canonical `git` (`builtin/log.c` `cmd_show`).

A design tension: if `bytes` dedups commits, how does the structured `objects`
array relate to the input arg list?

## Decision

- The faithful byte stream `bytes` is composed by a stateful recursive walk
  (`renderShowStream`) carrying `{ shownOne, shownCommits }`, reproducing both
  rules exactly (design §5). The tag → target blank line falls out of the flag,
  with no special-casing.

- **`objects` is per-arg; `bytes` is deduped.** `objects[i]` always corresponds
  to `input[i]` — every argument yields a structured result, so callers get a
  typed view of each rev they asked about. `bytes` applies git's commit dedup +
  separators. Thus a commit listed twice appears twice in `objects` but is
  rendered once in `bytes`.

- `show(input?: string | ReadonlyArray<string>, …)` accepts a single rev or an
  array; the single-string form is sugar for a one-element list. Default
  `'HEAD'`.

## Consequences

### Positive

- Byte-faithful to `git show A B …`, including the non-obvious blob-vs-commit
  separator asymmetry and commit dedup — pinned by multi-rev interop.
- The per-arg `objects` view stays intuitive (one result per argument) while
  `bytes` stays faithful — neither compromises the other.
- One `shown_one` flag covers inter-entry separation *and* tag → target
  spacing, so there is no bespoke tag-spacing code to drift.

### Negative

- `objects.length` can exceed the number of objects actually rendered in
  `bytes` (when a commit rev repeats) — documented; the two views answer
  different questions.
- The renderer is stateful (a small machine) rather than a pure `map` —
  unavoidable given git's order-dependent separator semantics.

### Neutral

- Dedup is keyed on the resolved oid, so two different revs naming the same
  commit (`HEAD` and its oid) also collapse in `bytes` — matching git.
