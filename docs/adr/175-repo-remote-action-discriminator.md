# ADR-175: `repo.remote(action)` as a single action-discriminated method

## Status

Proposed

## Context

Phase 20.5 ships five new verbs covering remote CRUD: `add`, `remove`,
`rename`, `set-url`, `show`, plus a `list` variant when no name is
passed. The shape question is how they sit on the `Repository` surface:

- **A: single action discriminator** — `repo.remote({ kind, … })`
  returning a discriminated `RemoteResult`. Same pattern `branch`,
  `tag`, and `sparseCheckout` already use.
- **B: five flat methods** — `repo.remoteAdd`, `repo.remoteRemove`,
  `repo.remoteRename`, `repo.remoteSetUrl`, `repo.remoteShow` (plus
  `repo.remoteList`). Same pattern Phase 20.4 picked for
  `abortMerge` / `continueMerge` (ADR-172).
- **C: nested namespace** — `repo.remote.add`, `repo.remote.remove`,
  …, with `repo.remote()` overloaded for the list case. Same shape
  isomorphic-git uses on its API.

ADR-172 picked flat methods for the merge state machine because abort
and continue have disjoint inputs/outputs and don't fit a CRUD family.
The remote verbs are the opposite case: every action carries a `name`
and produces a structurally similar result.

## Decision

A single `repo.remote(action: RemoteAction): Promise<RemoteResult>`
method with a discriminated `RemoteAction` input and a discriminated
`RemoteResult` output.

## Consequences

### Positive

- **Consistent with the existing CRUD family precedent.** `branch`,
  `tag`, `sparseCheckout` already use the same shape — a user who
  has learned one transfers the muscle memory to the other.
- **One TypeScript discriminator per family.** The narrowing story is
  uniform: switch on `kind`, branch through the type narrows from
  there. Five flat methods would split the surface across six
  unrelated signatures.
- **`Repository` surface stays compact.** One new method, not five
  or six. The discoverability cost is small: any user who types
  `repo.remote(` gets the `kind` literal-union prompted by the
  language server.
- **Result discriminator names what changed.** A `RemoteResult` with
  `kind: 'remove' | 'rename' | 'add' | …` carries the per-action
  payload (e.g. `removedTrackingRefs` only makes sense for `remove`)
  without optional fields that are undefined for the other actions.

### Negative

- **`repo.remote.add` autocomplete is lost.** A user typing
  `repo.remote.` sees no completions — they need to type
  `repo.remote({ kind: '` to discover the actions. Mitigation: the
  `docs/use/remote.md` page enumerates them; the discriminator union
  itself surfaces in tsdoc.
- **Each action carries a literal `kind` field at every call site.**
  Marginally noisier than `repo.remoteAdd({ name, url })`. The
  precedent is established; consistency wins.

### Neutral

- The merge state machine (Phase 20.4, ADR-172) picked the flat
  shape. The two decisions point in opposite directions because the
  two surfaces are shaped differently — CRUD vs disjoint state-
  machine transitions. ADR-175 explicitly defers to that case-by-
  case rule rather than imposing a universal pattern.

## Alternatives considered

- **B (five flat methods)** — rejected. Splits the family across the
  surface. `repo.remoteAdd` would be a one-of with no peers; `branch`
  / `tag` / `sparseCheckout` would still use the discriminator. Mixed
  precedent forces every future CRUD family to relitigate.
- **C (nested namespace `repo.remote.add`)** — rejected for the same
  reason ADR-172 rejected `repo.merge.abort`: turning `repo.remote`
  into a callable object requires a hand-rolled
  `function & { add, remove, … }` intersection type that the existing
  `BindCtx` helper does not express. The autocomplete win does not
  pay for the typing complexity.
