# ADR-272: Read-model convergence is focused, not a new abstraction layer

## Status

Proposed

## Context

23.4j is the capstone of the 23.4 API-foundation pass: "refactor the porcelain
reads into thin projections over the read model." It is sequenced **last** and
gated on an explicit over-design caution — *force nothing until the right shape is
evident from the full surface.*

Two readings of "the read model" were on the table:

1. **It already exists** — the read model *is* the Tier-2 read primitives the
   23.4a–i sub-items built and hardened (`walkCommitsByDate` / `walkCommits`,
   `revParse`, `readObject`/`readBlob`/`readTree`, `diffTrees`, `snapshot.*`).
   "Convergence" then means: the porcelain reads stop carrying bespoke copies of
   what those primitives already do, and call them instead.
2. **It is a layer still to build** — a unified `ReadModel` facade / first-class
   source accessors (`repo.tree(rev)`, `repo.index`, `repo.workdir`) that every
   read projects through.

Reading 2 collides head-on with two facts. First, the gating caution: a new
abstraction is precisely the kind of speculative shape the item tells us not to
force. Second, **23.4k already owns the accessor question** — it was deferred *and
gated on 23.4j* specifically so the accessor shape is decided **after** the model
proves out, not invented in the same breath.

A survey of the full read surface showed most reads already project cleanly
(`show`, `status`, `blame`, `describe`, `readFileAt`, `cat-file`, `reflog`). The
one genuine holdout is `log` (a bespoke first-parent walk + a weak bespoke
rev-resolver), with a lesser instance in `diff` (a bespoke tree resolver that
skips the rev grammar).

## Decision

Adopt **reading 1**: the read model is the existing Tier-2 primitives, and 23.4j
is a **focused convergence** of the holdouts onto them — **no new abstraction
layer, no new accessors**.

Concretely, 23.4j:

- converges `log` onto `walkCommitsByDate` (default) / `walkCommits`
  (`first-parent`) and onto the `revParse` grammar for rev resolution (ADR-273);
- adopts the `revParse` grammar in `diff`'s `from`/`to` resolution;
- extracts the shared `revParse` + `peelTo` resolution both `log` and `diff`
  co-own (architecture pass, behaviour-preserving);
- builds **no** `ReadModel` facade and **no** `repo.tree(rev)` / `repo.index` /
  `repo.workdir` accessors. The accessor shape stays the deferred **23.4k**, whose
  proof-out gate is exactly this convergence.

## Consequences

### Positive

- Honours the over-design caution: the capstone adds zero speculative surface; it
  *removes* duplication.
- Keeps 23.4k's accessor decision clean and deferred — 23.4j gives it the
  proof-out it was waiting for instead of pre-empting it.
- Every change traces to a concrete faithfulness gap or a real duplication, not to
  an architectural aspiration.

### Negative

- "Convergence" lands smaller than a reader expecting a grand read-model layer
  might assume. Mitigated: the smallness *is* the decision — the abstraction is
  rejected on purpose, and the item's own gating language asks for exactly this.

### Neutral

- The `snapshot.*` surface (working/index/tree state) is already the read model
  for non-commit state; this item does not touch it. 23.4k will weigh whether to
  add ergonomic accessors over it.
- Public-API delta is limited to `log`'s and `diff`'s option surfaces (ADR-273);
  no new top-level binding ships.
