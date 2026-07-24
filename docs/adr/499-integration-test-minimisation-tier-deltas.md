# 499 — Integration test minimisation: tier deltas over ADR-498

- **Status:** accepted (user judgment — ratified the design's recommendations, with one deviation on scope)
- **Date:** 2026-07-24
- **Design:** docs/design/integration-test-minimisation.md · **Refines:** [ADR-498](498-unit-test-minimisation-classification-proof-thresholds.md)
  (the standing Phase-27 minimisation methodology; ADR-498 already names the integration
  tier as an inheritor). Complements ADR-226 (git-faithfulness prime directive),
  ADR-105 (directory-based test classification), ADR-134/136 (property tests as additive siblings).

## Context

Backlog 27.2 minimises the **integration** tier the same way 27.1 minimised the unit tier:
collapse tests that drive the same journey/code-path with different fixtures into one
parameterised `it.each`; delete strict-subset tests. ADR-498 is the standing methodology
(KEEP/COLLAPSE/DELETE + guard-rails + proof-by-construction) and explicitly names 27.2/27.3
as inheritors, so this ADR records only the **tier deltas** rather than restating the rules.

Three facts make the integration tier differ from the unit tier and force the deltas below:

- **Coverage does not cover this tier.** `npm run test:coverage` runs `vitest run --project
  unit --coverage`; its `include` set is `src/{domain,ports,adapters/node,adapters/memory,
  operators}/**`. The integration project pins no coverage line, so 27.1's reliable coverage
  backstop (its §3.3) has **no analog** here.
- **Mutation is zero-signal for a tests-only PR** (unchanged from ADR-498): the PR mutation
  scope filters the diff to `^src/.*\.ts$`, so a tests-only change mutates nothing; local
  whole-bucket Stryker under-reports non-deterministically (stryker-js#5928).
- **The pyramid GWT/AAA/`sut` heuristics are unit-scoped.** In `test-pyramid-budgets.json`
  every gating heuristic carries `tier: unit`; the two integration heuristics
  (`integrationProof`, `overMockedIntegration`) are `gating=false` (report-only). So
  `check:test-pyramid` mechanically gates **nothing** on the shape of an integration `it()`.
  The one machine gate that binds the collapsed shape is biome `noThenProperty` (row field
  `label`, never `then`), via `biome check` in the part gate.

Most `test/integration/**` files are `-interop` tests that spawn **real git** and compare
byte-for-byte (cross-**tool** parity — the faithfulness pins of ADR-226). That is distinct
from the cross-**adapter** parity cross-products in `test/parity/**` / `test/runtime-parity/**`
/ `test/browser/**` (Node × Memory × Browser × Deno × Bun × Workers), which are out of scope.

## Options considered

### Decision 1 — backstop model (load-bearing; ratified)
1. **Proof-by-construction + reviewer-verified cross-tool preservation + green
   `test:integration` + targeted hand-verify** (chosen). Kill/behaviour preservation is a
   theorem from the union/strict-subset discipline; the reviewer verifies, by reading the
   diff, that each surviving `it.each` row still spawns git+tsgit and keeps the byte-exact
   compare over the union of fixtures; the suite proves surviving rows pass; risky edits are
   hand-verified deterministically. / cons: leans on reviewer discipline, not a headline number.
2. **Add integration to the coverage run** so a number backstops it. / cons: out of scope —
   a `vitest.config.ts`/CI edit this PR forbids; integration coverage is noisy and slow.
3. **Flip `integrationProof` gating to `true`** as the backstop. / cons: that gate checks
   `@proves` headers, not overlap; irrelevant to collapse correctness; a budget/manifest edit
   this PR excludes.

### Decision 2 — overlap definition precision (2a adopted-as-recommended; 2b ratified)
- **2a. "same journey" and "same code path" are ONE trigger** (chosen) — both collapse
  identically; a second trigger would double the rules with no operational difference.
- **2b. The consuming command MAY vary per `it.each` row** (chosen) — when the *code path*
  and every oracle shape are identical but the same path is reached through different git
  subcommands (missing-value refusal via `commit`/`fetch`/`push`), the command is carried as
  a row field (a `run` thunk + `gitArgs`). This is a **deliberate integration-tier extension
  of ADR-498's "one act per `it.each`"** — the collapse axis stays the single code path while
  the fixture *and* command vary. / alt: forbid command variance; cons: blocks the single
  richest collapse in the tier.

### Decision 3 — partition granularity + ordering (adopted-as-recommended)
1. **Per-file for the giants + themed grouped parts for the tail; untouched files get no
   part; order giants → themed tail → `network/`/platform subdirs late** (chosen). Balances
   atomic-commit reviewability against part count; fronts the highest-payoff overlap. Unlike
   ADR-498 there is no coverage-gated tier to front, so the ordering rationale is
   risk/payoff, not backstop strength. / 2. per-file uniformly (~100 parts) — overhead
   dominates a near-minimal tail; 3. one mega-part per theme — un-reviewable diffs.

### Decision 4 — refine vs standalone (adopted-as-recommended)
1. **This ADR *refines* ADR-498, recording only the tier deltas** (chosen); ADR-498 already
   names 27.2 as inheritor. / 2. restate the full methodology standalone — duplicates
   ADR-498, the two drift; 3. extend ADR-498 in place — muddies a ratified run-specific ADR.

### Decision 5 — minimum sibling count to collapse (adopted-as-recommended)
- **3** (chosen), mirroring ADR-498. At 2 siblings, COLLAPSE only when mechanically identical
  modulo one fixture literal (e.g. the earlier-by-line tie-break pair), else KEEP — a 2→1
  collapse saves little against the heavier interop row boilerplate.

### Decision 6 — platform-gated subdirs in scope? (ratified — DEVIATES from the design recommendation)
1. **Both `posix-only/` (5 files) and `win-only/` (2 files) in scope** (chosen by user).
   `posix-only/` is verified locally via the `posix-integration` project on this host;
   `win-only/` cannot run locally, so its minimisation is verified by construction-proof +
   `check:types` + `biome check` + reviewer diff-reading, with the **CI `win-integration`
   job as the green authority**. / 2. (design recommendation) posix-only in, win-only
   deferred — avoids committing a win-only collapse on a locally-unverifiable green; 3. both
   out of scope — excludes 5 verifiable files for no reason. The user chose (1): the deferral
   is not worth stranding the 2 files, and the construction proof + CI job is sufficient
   assurance for a tests-only regrouping that changes no production behaviour.

## Decision

**Inherited verbatim from ADR-498:** the KEEP/COLLAPSE/DELETE classification procedure, the
guard-rails (no dropped distinguishing/boundary input; no merged `if (A || B)` guards in one
row; no weakened error assertion; no mutable state shared across rows;
`.skip`/`.todo`/`.fails` and `*.properties.test.ts` left byte-identical), and the
proof-by-construction model (collapse relocates every `(Arrange→Act→Assert)` triple 1:1;
`it.each` re-expands to N independent runs; delete removes only strict-subset triples).

**Integration-tier deltas (this ADR):**

- **Preserved property gains a third clause (Decision 1, ratified).** Beyond "the multiset of
  executed triples does not shrink and no assertion is weakened", every surviving triple that
  spawned real `git` **still spawns real `git` and still compares byte-for-byte**. Dropping a
  row's git spawn or its cross-tool `expect(...).toBe/toEqual(...)` is the integration-tier
  equivalent of a resurrected mutant and is forbidden.
- **The backstop is construction + cross-tool-preservation review + green suite +
  hand-verify (Decision 1, ratified).** Coverage is zero-signal here (not measured), mutation
  is zero-signal (tests-only), the pyramid shape heuristics are report-only; the reviewer
  verifying the discipline by reading the diff is therefore load-bearing, and carries more
  weight than in 27.1.
- **Overlap has one trigger; the consuming command may vary per row (Decision 2, 2a adopted /
  2b ratified).** "Same journey" and "same code path" are one collapse trigger. An `it.each`
  row may carry its consuming git subcommand as a row field when the code path and all oracle
  shapes are identical — an explicit extension of ADR-498's one-act-per-`it.each` rule,
  bounded by the guard-rails (same path, same oracle shape, union of fixtures, per-row
  git+tsgit spawn preserved).
- **GWT/AAA/`sut` are preserved by convention, not gate (Decision 1 corollary).** Only
  `noThenProperty` (biome) machine-gates the collapsed shape. Each file's existing convention
  is preserved exactly — the bar is "no worse than today", not a retrofit of unit-tier GWT
  onto interop files that today bind `g`/`repo`/`ours`/`pair` rather than `sut`. Minimisation
  never introduces `sut` or re-titles kept tests, and never touches the `@proves` header, the
  `describe.skipIf(!GIT_AVAILABLE)` wrapper, or the `interop-helpers.ts` env/async plumbing
  (env-scrubbed `SAFE_ENV`; `gitAsync`, never sync, across same-process HTTP round trips).
- **Partitioning is per-file-giants + themed tail, giants first (Decision 3, adopted).**
  Each part is one atomic commit `test(integration): minimise <file-or-theme>` passing the
  part gate `npx vitest run <touched> && npm run check:types && biome check <touched>`;
  boundary checkpoint is `npm run test:integration`, final gate `npm run validate`.
- **Collapse threshold is 3 (Decision 5, adopted).**
- **Both platform subdirs are in scope (Decision 6, ratified — deviation).** `posix-only/`
  is verified locally under the `posix-integration` project; `win-only/` relies on
  construction-proof + `check:types` + `biome check` + the CI `win-integration` job as its
  green authority, since it cannot run on the darwin host. An implementer must not claim a
  local vitest green proves a `win-only` collapse.

**Cross-adapter parity carve-out (non-negotiable, restated).** `test/parity/**`,
`test/runtime-parity/**`, `test/browser/**` are left byte-identical — never collapsed,
deleted, nor counted as a retained test that could make an integration test a strict subset.
`-parity`-named files *inside* `test/integration/**` (`diff-patch-git-parity`,
`filter-driver-parity`) are cross-tool interop and **in scope**; the carve-out is by
directory, not by filename.

## Consequences

### Positive

- The integration tier shrinks toward one `it('Then …')` per distinct journey/code-path while
  every git-behaviour pin is preserved; reviews verify the discipline from the diff.
- No `src/` change and no threshold/budget/config edit, so git-faithfulness (ADR-226) and
  every gate floor are untouched by construction.
- 27.3 (e2e) inherits ADR-498 + these deltas; only its overlap surface differs.

### Negative

- The backstop is weaker than 27.1's: no coverage aggregate catches a silently dropped unique
  triple, so reviewer diff-reading and the construction proof carry the guarantee. A
  `win-only` collapse is verified only by CI, not locally.

### Neutral

- Only `noThenProperty` machine-gates the collapsed `it.each` shape; the rest of GWT/AAA/`sut`
  discipline is held by convention and reviewer judgment, matching the tier's existing norms.
- The consuming-command-per-row extension is scoped to this tier; the unit tier keeps
  ADR-498's literal one-act-per-`it.each` rule.
