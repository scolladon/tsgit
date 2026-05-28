# ADR-172: Flat `abortMerge`/`continueMerge` methods on the Repository surface

## Status

Accepted (at `f6678401f5a103a69747c81239b1d8e42a0d1fff`)

## Context

Phase 20.4 ships two new state-machine commands: abort and continue
for an in-progress merge. The natural question is shape:

- **A: flat methods** — `repo.abortMerge()`, `repo.continueMerge()`.
- **B: nested namespace** — `repo.merge.abort()`, `repo.merge.continue()`.
- **C: action discriminator** — `repo.merge({ action: 'abort' })`,
  `repo.merge({ action: 'continue' })`, plus the existing
  `repo.merge({ target })` for the actual merge.

Phase 22 will add three more abort/continue pairs (cherry-pick,
revert, rebase). Whichever shape we pick for merge will set the
pattern for those.

## Decision

Flat methods on `Repository`: `repo.abortMerge`, `repo.continueMerge`.

The Repository facade gets two new `BindCtx<typeof commands.*>`
properties bound the same way every other Tier-1 command is bound.
Phase 22 follows: `repo.abortCherryPick`, `repo.continueCherryPick`,
`repo.abortRebase`, `repo.continueRebase`, `repo.abortRevert`,
`repo.continueRevert`.

## Consequences

### Positive

- **Consistent with existing flat surface.** `checkout`, `reset`,
  `commit`, `clone` are all flat verbs. `abortMerge` reads in the
  same register.
- **Independent typing per command.** `abortMerge` returns
  `{ origHead, branch }`; `continueMerge` returns `CommitResult`.
  Flat methods declare independent input/output types without
  contortions; a single `merge` overload with `action` would have
  to express the union at the type level.
- **Simpler binding code.** Each flat method maps to one line in
  `repository.ts`'s factory; no nested-object wiring.
- **Pre-shapes Phase 22.** Six new flat methods land symmetrically.
  Nested or action-based shapes would need more decisions at that
  stage.

### Negative

- **Discoverability via autocomplete.** A user typing `repo.merge.`
  would NOT see `abort` and `continue` next to it. With flat
  methods, the user has to know the verbs exist. Mitigation:
  documented in `docs/use/merge.md`; the README's command index
  lists them under "Merge state machine".
- **Eight new top-level methods after Phase 22.** The `Repository`
  surface area grows. Each method is small and well-named, but
  the type lookup table gets denser.

### Neutral

- An alias layer (`repo.merge.abort = repo.abortMerge`) could be
  added later if user feedback wants the nested form. The flat
  form is the source of truth; aliases are non-load-bearing.

## Alternatives considered

- **B (nested namespace `repo.merge.abort`)** — rejected. `repo.merge`
  is currently a callable function. Turning it into a callable object
  with properties (`merge as function & { abort, continue }`)
  requires a TypeScript intersection that the existing `BindCtx`
  helper can't express. We'd need a hand-written binding and a
  hand-maintained type. The marginal discoverability win doesn't
  pay for the typing complexity.
- **C (action discriminator)** — rejected. `merge({ target })` and
  `merge({ action: 'abort' })` have nothing in common at the input
  type level (target vs. no target) or the output type level
  (`MergeResult` vs. `AbortMergeResult`). A discriminated input
  produces a discriminated output, which is exactly the kind of
  surface gymnastics the flat alternative avoids. Worse, the
  three flows mean very different things to users; conflating
  them on one method obscures intent.
