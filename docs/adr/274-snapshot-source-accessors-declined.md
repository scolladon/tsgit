# ADR-274: Snapshot source accessors — weighed and declined

## Status

Accepted (at `9e8f1833`)

Supersedes the deliverable-2 ("defer the accessors") half of
[ADR-260](260-snapshot-surface-deleak-defer-accessors.md).

## Context

[ADR-260](260-snapshot-surface-deleak-defer-accessors.md) split the
snapshot-surface work into two deliverables: *(1)* de-leak the wiring internals
(shipped) and *(2)* weigh four first-class **source accessors** —
`repo.tree(rev)`, `repo.index`, `repo.workdir`, `repo.stash` — over the existing
`repo.snapshot.*` factory. Deliverable 2 was **deferred, not dropped**, on three
frictions, two of which were "this preempts items not yet designed":

1. `repo.stash` collides with the shipped stash *command* namespace.
2. `repo.tree(rev)` needs rev→tree resolution — the heart of `readFileAt`
   (23.4c) and the `rev` vocabulary (23.4e).
3. `repo.index` / `repo.workdir` are thin getters whose shape belonged to the
   read-model convergence capstone (23.4j).

All three gating items (23.4c, 23.4e, 23.4j) have since shipped, so the weigh is
now decidable on its merits. The convergence ([ADR-272](272-read-model-convergence-scope.md))
is the decisive datum: it routed `log`/`diff` through the Tier-2 read
**primitives**, adding *"no new abstraction layer, no new accessors"*, and noted
that `repo.snapshot.*` *"is already the read model for non-commit state."* The
experiment the accessors were waiting on returned **"not needed."**

The remaining argument for the accessors is therefore purely external consumer
ergonomics — saving a caller one word or one `revParse` call — weighed against
the project's KISS/YAGNI posture and the altitude boundary between the porcelain
`repo.*` surface and the `repo.snapshot.*` power-tool namespace.

A second force is **reversibility asymmetry**. Inside the 23.4 breaking window
(open until the end of Phase 28) any shape can still be reshaped; at window close
it freezes. *Not* adding an accessor is fully reversible — a method can be added
later, additively (non-breaking), even after the window. *Adding* one commits a
name and an altitude decision that is breaking to undo post-window.

## Decision

**Decline all four top-level source accessors.** Reach every source through the
cohesive `repo.snapshot.*` factory, unchanged. Per accessor:

- **`repo.stash`** — cannot ship: hard collision with the stash command
  namespace. The snapshot equivalent is `repo.snapshot.stashEntry(i)`.
- **`repo.index` / `repo.workdir`** — declined: as getters they cannot carry
  `SnapshotOptions` / `WorkdirSnapshotOptions` (strictly less capable than the
  methods they shadow); as methods they are verbatim aliases of
  `repo.snapshot.index(opts?)` / `repo.snapshot.workdir(opts?)` (two ways to do
  one thing). Either form fragments the namespace to save one word.
- **`repo.tree(rev)`** — declined: the sole accessor with new capability
  (rev→tree), but it (a) hoists a power-tool `TreeSnapshot` into the porcelain
  `repo.*` altitude that ADR-260 deliberately separated, (b) overloads the
  existing `repo.snapshot.tree(oid)` verb with a different parameter meaning, and
  (c) folds exactly one `revParse` call —
  `repo.snapshot.commit(await repo.revParse(rev))` already works. If real demand
  ever surfaces, the faithful home is *inside* `repo.snapshot.*` (teach a method
  to accept a rev), preserving altitude — not a top-level accessor.

This converts ADR-260's *"deferred"* into a settled *"weighed → declined."* It is
behaviour-preserving: no SHA, ref, reflog, on-disk state, refusal, or output
change, and no `reports/api.json` change (no new public member). The decision is
regression-pinned by an API-surface test asserting the top-level `repo` handle
exposes no `tree` / `index` / `workdir` source accessor.

## Consequences

### Positive

- The altitude boundary stays clean: `repo.*` is porcelain (commands +
  structured-data reads); `repo.snapshot.*` is the lazy power-tool query layer.
  The API shape keeps *teaching* that distinction.
- `repo.snapshot.*` remains the single, cohesive home for every source — no
  fragmentation, no two-ways-to-do-one-thing, no `stash` asymmetry wart.
- Zero new public surface to maintain, gate, or later reshape; `api.json`
  unchanged.
- Maximally reversible: any accessor can still be added later, additively, once
  real demand and the right shape are evident.

### Negative

- Tree-at-rev stays a two-step call on the power-tool surface
  (`repo.snapshot.commit(await repo.revParse(rev))`). Accepted: it is confined to
  advanced usage and is fixable later inside the namespace without the altitude
  inversion.
- Callers keep spelling `repo.snapshot.index()` rather than a shorter
  `repo.index`. Accepted: the saving is one word.

### Neutral

- The `snapshot` name is reaffirmed (ADR-260), untouched.
- 23.4k is completed by the weigh itself; the deliverable is the decision, not
  code.
