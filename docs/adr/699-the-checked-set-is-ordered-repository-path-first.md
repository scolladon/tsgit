# 699 — The checked set is ordered repository-path first

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/ownership-trust-gate.md (candidate DN-3) · **Refines:** ADR-676, ADR-684

## Context

ADR-676 fixed the **set** the ownership predicate checks (`gitDir`, `commonDir`, repository path,
deduplicated). ADR-684 fixed the **rule** for reporting it: `foreignPath` names the first failing
member in the deduplicated check order. Neither chose that **order**, and the combination makes
the order publicly observable.

With `[gitDir, commonDir, repoPath]`, the ordinary case — every path alien — populates
`foreignPath` with `<repo>/.git`, a directory *inside* the one `path` already names. The field
then carries no information in the common case, and the uncommon case ADR-684 exists for (an
owned repository path pointing at a foreign gitdir) becomes indistinguishable from it.

## Options considered

1. **Keep `[gitDir, commonDir, repoPath]`** — cons: `foreignPath` is populated with redundant
   information on every ordinary refusal, defeating ADR-684's purpose.
2. **Reorder to `[repoPath, gitDir, commonDir]`** — pros: `foreignPath` is absent exactly when
   `path` already says everything, and present exactly when it does not; ADR-684's two rules stay
   verbatim; no conditional is introduced.
3. **Keep the original order and suppress `foreignPath` unless `path` is itself owned** — pros:
   same observable / cons: adds a conditional to specify, test and mutate, for an outcome
   ordering achieves for free.

## Decision

**Option 2 — adopted as recommended (no user judgment).**

The deduplicated check order is `[repositoryPath, gitDir, commonDir]`.

Nothing measured moves: the set membership, the allowlist short-circuit, and the 1/2/3 `stat`
counts of ADR-676 are all order-independent. Only which member `foreignPath` reports changes, and
it changes to the informative one.

## Consequences

- `foreignPath` is present precisely when it adds information — which is the property that makes
  it worth having, and the one an implementation could silently lose by reordering the set.
- The order is therefore load-bearing and belongs in the code as a named, commented constant, not
  as an incidental array literal.
- Option 3 stays available if a future requirement needs the field populated unconditionally; it
  would supersede this ADR rather than sit beside it.
