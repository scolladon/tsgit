# ADR-192: Per-verb result types (strip discriminator) for migrated CRUD families

## Status

Accepted (at `2a54c19`)

Implements the migration ADR-181 deferred to backlog 20.8.

## Context

ADR-181 adopted the nested-namespace shape for CRUD families and stated the
four existing action-discriminated families (`repo.remote`, `repo.branch`,
`repo.tag`, `repo.sparseCheckout`) would be migrated "to match" the
`repo.config` shape shipped in 20.6.

`repo.config` has two defining traits: per-verb concrete **input** types and
per-verb concrete **result** types — neither carries a `kind`/`action`
discriminator. ADR-181 lists "Result types stay per-action … no
discriminated-union narrowing needed at the call site" as a first-class
Positive.

The four families today return discriminated unions (`RemoteResult` with
`kind`, etc.). "Mechanical: `repo.X({ kind: 'verb' })` → `repo.X.verb({})`"
in the backlog describes only the **input** transformation. The open
question is the **result**:

- **A: strip the discriminator** — each verb returns a concrete result type
  with no `kind` field (`repo.remote.add(...) → { remote }`). Requires a
  full split of each family into per-verb Context-aware functions and
  deletion of the discriminated dispatcher.
- **B: keep the discriminator** — thin-wrapper the existing
  `remote(ctx, action)` dispatcher; the namespace forwards
  `{ kind, ...input }` and narrows the return to
  `Extract<RemoteResult, { kind: 'verb' }>`. Smaller diff, but the result
  object keeps a statically-redundant `kind` field and the discriminated
  union ADR-181 rejected stays alive internally.

## Decision

Adopt **A**. Split each of the four families into per-verb Context-aware
functions (`remoteList`, `remoteAdd`, `remoteRemove`, …) returning per-verb
concrete result types with **no discriminator**, mirroring `commands/
config.ts`. Delete the discriminated dispatchers (`remote(ctx, action)`,
`branch(ctx, action)`, `tag(ctx, action)`, `sparseCheckout(ctx, opts)`) and
their `*Action` / `*Result` union types. Each family gains a
`commands/internal/<family>-namespace.ts` (`*Namespace` type +
`bind*Namespace(ctx, guard)`), mirroring `config-namespace.ts`.

`sparseCheckout`'s old `kind: 'list' | 'applied'` (not 1:1 with the verb)
collapses to two concrete types: `SparseCheckoutListResult` for `list` and a
shared `SparseCheckoutAppliedResult` for `set`/`add`/`reapply`/`disable`.

Per-verb behaviour, error codes, refspec rules, ordering, and git-faithful
edge cases are preserved byte-for-byte — only the call/type shape changes.

## Consequences

### Positive

- **Exact `repo.config` parity** — one structure across all five CRUD
  families; learning one transfers to the rest.
- **Concrete result types** — no discriminated-union narrowing at call
  sites; each method's return is exactly its payload.
- **No dead union** — the `*Result` unions are gone, not retained-and-hidden.
- **`sparseCheckout` discriminator inconsistency** (`action` vs `kind`)
  disappears entirely.

### Negative

- **Wider breaking change** — result objects lose `kind`; ~19 parity-scenario
  assertions and the scenario golden result types update.
- **More named types** — per-verb input/result interfaces replace one union
  per family. Mitigated: matches the config precedent; expressivity > brevity.

### Neutral

- Shared value types (`RemoteInfo`, `RemoteShow`, `BranchInfo`, `TagInfo`)
  are unchanged.
- `reflog` and `submodules` (also discriminated) are out of scope — ADR-181
  names exactly these four families.
