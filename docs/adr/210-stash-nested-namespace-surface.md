# ADR-210: `stash` ships as a nested namespace `repo.stash.*`

## Status

Accepted (at `5fa805d6`)

## Context

`stash` is a multi-verb porcelain family (`push`, `list`, `apply`, `pop`,
`drop`). The repository facade has two precedents for multi-verb surfaces: the
original action-discriminated single method (ADR-175, now Deprecated) and the
nested per-verb namespace (ADR-181 / ADR-192) used by `repo.branch`,
`repo.config`, `repo.remote`, `repo.tag`, `repo.sparseCheckout`. `stash` is not
in ADR-181's original CRUD enumeration, so the choice must be made explicitly.

## Decision

`stash` is a **nested namespace** `repo.stash.{push,list,apply,pop,drop}`,
following ADR-181 / ADR-192 verbatim:

- per-verb Context-aware functions in `commands/stash.ts`, each with a concrete
  result type — no `kind`/`action` discriminator on the **input**;
- bound via `commands.bindStashNamespace(ctx, guard)`, returning a frozen,
  non-callable object whose methods run `guard()` then forward;
- results may still be discriminated unions on `kind` (e.g. `push` →
  `'saved' | 'no-local-changes'`, `apply` → `'applied' | 'conflict'`) — that is
  an output shape, not an input dispatcher, consistent with `merge`'s result.

## Consequences

### Positive

- One consistent multi-verb convention across the whole facade; no revival of
  the Deprecated callable discriminator (ADR-193).
- Discoverable, individually-typed verbs; tree-shakeable command functions.

### Negative

- `stash` widens the namespace count on `Repository`; the doc-coverage audit
  must learn `commands.StashNamespace` like the other five (ADR-194).

### Neutral

- The browser-surface namespace awareness for `stash` rides the same path as the
  other namespaces (deferred bucket per ADR-194).

## Alternatives considered

1. **Action-discriminated single method** (`repo.stash({ action: 'push', … })`) —
   rejected: ADR-175 is Deprecated and ADR-193 hard-removed the callable form.
2. **Flat top-level methods** (`repo.stashPush`, `repo.stashPop`, …) — rejected:
   pollutes the top-level surface and breaks the established grouping convention.
