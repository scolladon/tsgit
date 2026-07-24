# 498 — Unit test minimisation: classification, proof model, and thresholds

- **Status:** accepted (user judgment — ratified the design's recommendations)
- **Date:** 2026-07-23
- **Design:** docs/design/unit-test-minimisation.md · **Refines/Supersedes:** none
  (new standing methodology; complements ADR-105 directory-based test classification,
  ADR-108 pyramid-audit tooling policy, ADR-134/136 property-tests-as-additive-siblings)

## Context

Backlog 27.1 minimises the unit tier to "one `it('Then …')` per distinct behaviour"
while holding the existing outcome bar unchanged: 100% line/branch/function/statement
coverage AND only provably-equivalent mutants surviving, with GWT-discipline titles
preserved. Phase 27 is a series (27.1 unit, 27.2 integration, 27.3 e2e) that will reuse
the same classification and proof reasoning, so the rules want a standing home rather
than re-derivation per item.

Two facts make the mutation half of the bar unmeasurable for this work, and force the
proof to be constructive rather than empirical:

- **CI PR mutation is zero-signal for a test-only PR.** `compute-mutation-scope.sh`
  filters the PR diff to `^src/.*\.ts$`; a tests-only change yields an empty mutate-list,
  so `run-stryker-pr` prints "No src/ files … skipping" and exits 0 — it audits nothing.
- **Local whole-bucket Stryker under-reports non-deterministically** (vitest-4 pairing,
  stryker-js#5928) — a before/after killed-count delta can neither confirm nor deny a
  resurrection.

`main` already meets the bar (the 26.12 whole-codebase sweep left only
documented-equivalent survivors; `test:coverage` is green at 100%). This work therefore
*preserves* an already-met guarantee; it never has to establish one — which is what makes
proof-by-construction sufficient.

## Options considered

### Mutation-preservation proof strategy
1. **Proof-by-construction + coverage backstop + targeted hand-verify** (chosen) — kill
   preservation is a theorem from the collapse/delete discipline; `test:coverage` is the
   reliable backstop; risky edits are hand-verified by activating the specific at-risk
   mutant. / cons: relies on reviewer discipline, not a headline score.
2. **Full local Stryker sweep per partition, before/after compare.** / cons: untrustworthy
   (vitest-4 non-determinism); multi-hour off-hours job per partition.
3. **Post-merge whole-tree sweep to confirm.** / cons: splits the guarantee out of the PR;
   defers detection past merge.

### Partition granularity + ordering (run-specific)
1. **Per-subsystem directory + per-file for the giants; order domain → operators/ports/
   adapters → small non-gated → application** (chosen). / balances atomic-commit
   reviewability against part count; coverage-gated tiers first.
2. **Per-subtree (8 mega-parts).** / cons: un-reviewable diffs; regressions hard to localise.
3. **Per-file uniformly (484 parts).** / cons: process overhead dominates.

### Standing ADR vs doc-only
1. **Standing ADR (this document)** (chosen) — 27.x reuses it. / 2. doc-only (27.2+ drift);
   3. fold into an existing testing ADR (no clean home; dilutes both).

## Decision

**The classification procedure (standing).** For each `it()` under one `describe('When …')`,
with a test's *act* = its SUT call(s), *oracle* = its `expect(…)` expression shape, and
*distinguishing inputs* = the literals that differ from siblings:

- **KEEP** verbatim if act OR oracle differs from every sibling, or it isolates a
  guard/boundary no other kept test isolates.
- **COLLAPSE** into one `it.each` when **3+** siblings share the same act AND oracle shape,
  differing only in row literals. The row matrix MUST be the **union** of every sibling's
  distinguishing inputs and expected oracles — no input dropped, no oracle weakened.
- **DELETE** only when a test's (inputs × assertions) is a **strict subset** of one
  retained test (containment in both dimensions). Relocating an extra assertion into the
  retained row before deleting is part of a legal delete; it adds no new `it()`.

**Guard-rails (standing).** A collapse/delete is illegal — revert to KEEP — if it would
drop a distinguishing/boundary input, merge two guard conditions of an `if (A || B)` into
one row, weaken an error assertion (per-row `.data`; never `toThrow(Class)`), or share
mutable state across `it.each` rows (each row's Arrange stays inside the callback).
`.skip`/`.todo`/`.fails` blocks and `*.properties.test.ts` files are left byte-identical.

**Proof model (standing) — Decision 1, ratified.** Mutation-kill preservation is proven
**by construction** (collapse relocates every AAA triple 1:1; `it.each` re-expands to N
independent runs; delete removes only triples a retained test still runs), audited by
`npm run test:coverage` (reliable, 100%) plus **targeted hand-verification** of at-risk
mutants (activate the specific mutant via `__STRYKER_ACTIVE_MUTANT__` / hand-applied
replacement, confirm the collapsed test still fails). No Stryker sweep gates this PR — it
is zero-signal in CI and non-deterministic locally for a tests-only change.

**Thresholds.** Minimum sibling count to collapse = **3** (Decision 4a, ratified; at 2,
KEEP unless mechanically identical modulo one literal). Sibling `Given` blocks are unified
into one parameterised `Given` only when one *truthful* phrasing covers all rows, and stay
separate when they name distinct behaviour classes (Decision 4b,
adopted-as-recommended — no user judgment). Coverage checkpoint cadence =
per-partition-boundary + final `validate` (Decision 4c, adopted-as-recommended — no user
judgment).

**Execution ordering (run-specific to 27.1 — Decision 2, ratified).** Parts are cut one
per subsystem directory, with a dedicated part per giant file (>1.5k LOC), ordered
domain → operators/ports/adapters → small non-gated (repository/transport/api-surface/root)
→ application last. This ordering is specific to this run; 27.2/27.3 re-cut their own.

## Consequences

- The methodology is mechanical and reviewable: a reviewer verifies the *discipline*
  (matrix-is-union, delete-is-strict-subset, no weakened oracle) by reading the diff — not
  a mutation score.
- No `src/` change: git-faithfulness (ADR-226) is untouched by construction, and no
  threshold/budget file (`mutation-budgets.json`, `test-pyramid-budgets.json`) moves.
- 27.2 (integration) and 27.3 (e2e) inherit the KEEP/COLLAPSE/DELETE rules, guard-rails,
  and proof model from this ADR; only their overlap definition and partitioning differ.
- Coverage remains the mechanical backstop for the gated tiers; the application tier (whose
  `src` is not coverage-gated) leans on construction + hand-verify, which is why it is
  sequenced last, once the discipline is proven where coverage guards it.
