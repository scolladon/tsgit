# ADR-213: `stash` selector is a numeric stack index

## Status

Accepted (at `5fa805d6`)

## Context

`apply`/`pop`/`drop` must choose a stash entry. git's CLI spells this
`stash@{N}`. tsgit could accept that string, a numeric index, or both. The
`refs/stash` reflog is intrinsically index-addressed (newest = 0), and
`drop`/`pop` need the numeric position anyway to rewrite the stack.

## Decision

The verbs take `{ index?: number }`, default `0` (newest). The stash entry is
resolved by reading the `refs/stash` reflog and selecting the `index`-th entry
newest-first (file position `length - 1 - index`), returning its `newId` (the W
commit). Out of range → `STASH_NOT_FOUND { index, stackSize }`.

This resolution is a stash-internal read (`stash-ref.ts`), **not** the shared
`rev-parse` DWIM path. The `stash@{N}` string sugar and `rev-parse stash@{N}`
support are separate (the latter is delivered by ADR-216's ladder fix, but the
stash verbs themselves stay index-typed).

## Consequences

### Positive

- Typed, unambiguous, matches the stack model; one resolver serves apply, pop,
  and drop. No stringly-typed parsing in the hot path.

### Negative

- Callers used to `stash@{2}` muscle-memory pass `{ index: 2 }` instead; the
  `stash@{N}` string form is not accepted at the API (only via `rev-parse` once
  ADR-216 lands).

### Neutral

- `list` still emits the `stash@{N}` `selector` string for display, so the two
  representations interoperate.

## Alternatives considered

1. **`stash@{N}` string** — rejected: stringly-typed, still must be parsed into
   an index for drop/pop, no real ergonomic win in a library API.
2. **Both (index or string)** — rejected for v1: doubles the validation surface
   for marginal benefit; can be added additively later without breaking the
   numeric form.
