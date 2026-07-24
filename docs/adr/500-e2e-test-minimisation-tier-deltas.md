# 500 — E2E test minimisation: tier deltas over ADR-498/499

- **Status:** accepted (user judgment — ratified the design's recommendation on the
  load-bearing reading; the remaining choices adopted-as-recommended)
- **Date:** 2026-07-24
- **Design:** docs/design/e2e-test-minimisation.md · **Refines:**
  [ADR-498](498-unit-test-minimisation-methodology.md) (the standing Phase-27 minimisation
  methodology, which already names the E2E tier as an inheritor) and
  [ADR-499](499-integration-test-minimisation-tier-deltas.md) (the integration-tier deltas).
  Complements ADR-226 (git-faithfulness prime directive), ADR-105 (directory-based test
  classification), ADR-127 (by-name scenario lookup across the `page.evaluate` boundary),
  ADR-134/136 (property tests as additive siblings).

## Context

Backlog 27.3 minimises the **E2E** tier — the Playwright browser specs under
`test/browser/**` — under the same overlap definition 27.1 (unit) and 27.2 (integration)
used: keep one flow per distinct journey; collapse flows that assert the same journey with
different inputs into one parameterised case; delete strict-subset flows. ADR-498 is the
standing methodology (KEEP/COLLAPSE/DELETE + guard-rails + proof-by-construction) and names
27.3 as an inheritor, so this ADR records only the **E2E-tier deltas**, exactly as ADR-499
did for the integration tier.

The E2E surface (from `playwright.config.ts`: `testDir ./test/browser`, `testMatch
*.spec.ts`, projects `chromium`/`firefox`/`webkit`) is **12 bespoke `test()` cases across 4
spec files** — `opfs-roundtrip` (1), `hash-interop` (2), `decompression-stream` (3),
`surface-parity` (6) — plus the cross-adapter parity driver `parity.spec.ts` (a
registry-completeness guard + the 34 `SCENARIOS` run against an OPFS-backed `Repository`).

Four facts make the E2E tier differ from the unit and integration tiers and force the deltas
below:

- **Every mechanical correctness signal is dark.** `npm run test:coverage` runs
  `vitest run --project unit --coverage` over `src/{domain,ports,adapters/node,
  adapters/memory,operators}/**`; Playwright is not a vitest project and `adapters/browser`
  is not even in the coverage `include` set, so a deleted E2E flow can never move a coverage
  number. The PR mutation scope filters the diff to `^src/.*\.ts$` (tests-only ⇒ mutates
  nothing), and Stryker mutates `src/` against the **unit** suite only — it never loads a
  Playwright spec, so even a full local sweep audits nothing about E2E. Every gating heuristic
  in `test-pyramid-budgets.json` carries `tier: unit`, so `check:test-pyramid` mechanically
  gates nothing on the shape of a Playwright `test()`. Where 27.2 lost coverage but kept a
  cross-tool byte-compare, the E2E tier has **no** headline number of any kind.
- **The browser *engine* is a new distinguishing axis.** WebKit's headless Playwright build
  exposes no OPFS (`navigator.storage.getDirectory`), so every OPFS-backed flow skips webkit;
  only the pure-capability probes (SubtleCrypto SHA-1; DecompressionStream) run on all three
  engines. Engine coverage is a distinguishing input, like a boundary value.
- **The collapse idiom is a `for…of` loop over `test()`, not `it.each`.** Playwright has no
  `it.each`; the in-repo exemplar is `parity.spec.ts`'s `for (const scenario of SCENARIOS)`
  loop, which emits one `test()` per row.
- **The parity carve-out now lives *inside* the tier's own directory.** ADR-499 carved
  `test/browser/**` out wholesale as a sibling directory. For 27.3 the E2E scope *is*
  `test/browser/**`, so the carve-out must be drawn by **mechanism** — the SCENARIOS-driving
  cross-adapter *driver* (`parity.spec.ts` + `parity-scenarios.bundle.ts`) — not by directory
  or filename. `surface-parity.spec.ts`, despite its name, is **not** the driver; it is 6
  bespoke single-command journeys and is **in** the audit (the inverse of ADR-499's note that
  `-parity`-named files inside `test/integration/**` are in scope).

## Options considered

### Decision 1 — does the browser parity run "cover" a bespoke journey? (pivotal, ratified)

The 34 `SCENARIOS` run on the OPFS browser adapter by `parity.spec.ts` include journeys three
bespoke flows also assert (`opfs-roundtrip` ↔ `init-add-commit-status`, `surface-parity·branch`
↔ `branch-lifecycle`, `surface-parity·notes` ↔ `notes`). "Parity cross-products excluded from
the overlap audit" cuts two ways:

1. **(A) Aggressive — parity covers the journey; delete the redundant flows.** The browser
   parity run already asserts init→add→commit→status / branch / notes on the browser adapter,
   so treating their differing seed content/message/note as non-distinguishing makes them
   redundant → delete `opfs-roundtrip.spec.ts` and the branch/notes blocks of
   `surface-parity.spec.ts`. / cons: they are **not literal strict subsets** — each bespoke
   flow seeds `'hello browser\n'` while its parity counterpart seeds `FILES.helloA =
   'hello a\n'` (and the messages/note-text differ too), so the SHAs differ and the bespoke
   flows assert a 40-hex *regex* rather than the golden. Deleting them requires *loosening*
   "distinguishing input" beyond what 27.1/27.2 applied; it contradicts the backlog clause and
   ADR-499's precedent that parity is "NOT overlap … stay distinct" and "never counted as a
   retained test"; and it strands the tier's independent browser-engine smoke path (per-step
   localisation, input-independence) behind a golden-locked cross-adapter test owned by a
   different concern.
2. **(B) Conservative — parity is a different axis, excluded from the audit; keep all bespoke
   flows** (chosen by user). The audit compares bespoke flows against **each other only**; the
   parity driver is never a comparand and covers nothing. The bespoke set then has zero
   cross-overlap → the E2E tier is already minimal → 27.3 is a *confirming audit* that deletes
   no tests. / directly honours the backlog's own definition and ADR-499's non-negotiable;
   preserves the tier's independent browser-engine guarantee. / cons: 27.3 lands as a
   (near-)empty implementation PR — legitimate but unusual for a minimisation item.
3. **(C) Strict application only — delete only a *literal* strict subset.** Because every
   bespoke flow seeds `'hello browser\n'` while its parity counterpart seeds `'hello a\n'`,
   **no** flow is a literal subset → (C) deletes nothing. So the *strict* ADR-498 methodology,
   applied without loosening "distinguishing input", already yields (B)'s outcome; only the
   looser (A) deletes anything. / offered to show the strict methodology and (B) agree.

The user chose **(B)**: the backlog wording carried verbatim from 27.2, and ADR-499's restated
non-negotiable, both classify cross-adapter parity as a distinct axis that is never a retained
comparand; the strict ADR-498 subset test independently deletes nothing here (C≡B). Reading A
would require a genuinely looser notion of "distinguishing input" than the two shipped tiers
used, for the sole benefit of deleting three flows that each carry an independent
browser-engine assertion.

### Decision 2 — the E2E-tier backstop model (adopted-as-recommended)

1. **Construction-proof + browser-engine-preservation review + green `test:e2e` (CI
   authority) + parity-goldens-unchanged + targeted hand-verify** (chosen). Journey
   preservation is a theorem from the union/strict-subset discipline; the reviewer verifies
   per-flow engine coverage and union-of-inputs by reading the diff; the suite proves surviving
   flows pass; goldens are provably untouched. / cons: leans on reviewer discipline, not a
   headline number — more so than 27.2, since no cross-tool byte-compare exists either.
2. **Add the browser adapter / E2E to a coverage run** so a number backstops it. / cons: out
   of scope — a `vitest.config.ts`/Playwright-config/CI edit this PR forbids; real-engine
   Playwright coverage is noisy and slow.
3. **Gate on a new E2E pyramid heuristic.** / cons: none exists; authoring one is a
   budget/tooling change this PR excludes and would check shape, not overlap.

### Decision 3 — secondary shape choices (adopted-as-recommended)

- **3a. `hash-interop` (a) + (b) stay separate.** Different acts (raw `BrowserHashService`
  vs facade `writeObject`/`readBlob`), different oracles (hex-equality vs byte round-trip),
  different engine-gating ((a) runs webkit, (b) is OPFS-skipped). Merging would force (b)'s
  webkit-skip onto (a), zeroing the only webkit SHA-1 probe. / alt: merge under one
  `describe` — loses a `(journey, engine)` pair.
- **3b. A kept flow keeps its `test.step` granularity verbatim.** `test.step` is a flow's
  error-localisation contract, not overlap. / alt: flatten to one assertion block — degrades
  failure diagnostics for no coverage gain.
- **3c. This ADR *refines* ADR-498/499, recording only the E2E-tier deltas.** ADR-498 names
  27.3 an inheritor. / alt: restate standalone (duplicates 498/499, they drift); extend
  ADR-499 in place (muddies a ratified run-specific ADR).

### Decision 4 — whole tier in one PR? (adopted-as-recommended)

1. **All 4 bespoke spec files audited in one PR** (chosen), matching 27.1/27.2's whole-tier
   scope. The tier is tiny (12 cases), so a single PR is reviewable. / 2. file-by-file PRs —
   process overhead dominates a 12-case tier. / 3. defer OPFS-gated flows the darwin host
   can't fully run — CI `e2e` covers them; no reason to strand.

## Decision

**Inherited verbatim from ADR-498 (via ADR-499):** the KEEP/COLLAPSE/DELETE classification
procedure, the guard-rails (no dropped distinguishing/boundary input; no weakened error
assertion; no mutable state shared across parameterised rows;
`.skip`/`.todo`/`.fails` and `*.properties.test.ts` left byte-identical), and the
proof-by-construction model (collapse relocates every `(Arrange→Act→Assert)` triple 1:1; the
loop re-expands to N independent runs; delete removes only strict-subset triples).

**E2E-tier deltas (this ADR):**

- **The preserved property gains a browser-engine clause (Decision 2 corollary).** Beyond
  "the multiset of asserted journeys does not shrink and no assertion is weakened", **every
  surviving flow that ran against a real browser engine still runs against that same
  engine**: the multiset of asserted `(journey, engine)` pairs does not shrink. Dropping a
  flow that is the *sole* executor on an engine (the webkit-running SubtleCrypto /
  DecompressionStream probes) is the E2E-tier equivalent of a resurrected mutant and is
  forbidden. The `test.skip(browserName === 'webkit', …)` and OPFS-skip guards are preserved
  byte-exact on every kept flow.
- **The backstop is construction + engine-preservation review + green `test:e2e` +
  goldens-unchanged + hand-verify, with CI as the green authority (Decision 2, adopted).**
  Coverage drives none of this tier, PR mutation is zero-signal, local Stryker never loads a
  Playwright spec, and the pyramid heuristics are unit-scoped; the reviewer verifying the
  discipline from the diff is therefore load-bearing and carries even more weight than in 27.2.
  An implementer must not claim a partial local run proves a cross-engine change — the darwin
  host's headless webkit lacks OPFS, so CI is the authority for engines it cannot exercise.
- **The collapse idiom is a `for…of` loop over `test()`/`test.describe()`, not `it.each`
  (Decision 3 corollary).** Playwright has no `it.each`; the matrix is the union of merged
  flows' inputs *and* engine-gating. A kept flow's `test.step` granularity is preserved
  verbatim (Decision 3b). The one machine gate that binds a collapsed shape is biome
  `noThenProperty` (row field `label`, never `then`), via `biome check` in the part gate.
- **GWT/AAA are preserved by convention, not gate.** E2E specs already diverge from unit-tier
  GWT: they use `test`/`test.describe`/`test.step`, bind `result`/`contents`/`entries` (not
  `sut`), and put Given/When/Then in the `test()` title. Minimisation preserves each file's
  existing convention exactly — the bar is "no worse than today", never a `sut`-retrofit — and
  never touches the `readyPage`/`seedRepo` fixtures, the engine-skip guards, `serve.mjs`, or
  `index.html`.
- **The parity carve-out is drawn by mechanism, not directory or filename (Context delta 4;
  Decision 1 corollary).** `parity.spec.ts` + `parity-scenarios.bundle.ts` (and everything
  under `test/parity/**` / `test/runtime-parity/**`) are left byte-identical — never
  collapsed, deleted, nor counted as a retained flow that could make a bespoke flow a subset.
  The cross-adapter driver proves cross-**adapter** equivalence (a different axis from
  user-journey coverage), which is destroyed by collapsing across adapters/engines.
- **The audited scope is the whole tier in one PR (Decision 4, adopted).**

**Outcome of the audit (Decision 1 = Reading B).** The complete 12-case audit (verified
against the real specs and the real scenario goldens, tabled in the design doc) finds **no
cross-bespoke overlap**: each bespoke flow asserts a distinct journey/capability no other
bespoke flow asserts, and the parity driver is not a comparand. The E2E tier was constructed
one-flow-per-capability across earlier phases with parity as the deliberately separate
cross-adapter axis, so it is **already at one-flow-per-journey**. 27.3 therefore lands as a
**confirming audit that deletes and collapses no tests** — the implementation phase is an
honest no-op (precedented by 27.2's "files with no real collapse candidate are not touched",
applied here to the whole tier). The PR is this design doc + this ADR + the backlog tick; no
`src/` change, no test change, no threshold/budget/config edit.

## Consequences

### Positive

- The E2E tier is confirmed at one Playwright flow per distinct journey/capability, with every
  browser-engine probe and every parity golden provably intact.
- No `src/` change and no threshold/budget/config edit, so git-faithfulness (ADR-226) and every
  gate floor are untouched by construction; the cross-adapter parity proof is byte-identical.
- The audit records, for future readers, *why* each bespoke flow is distinct — turning an
  implicit "the tier looks minimal" into a checked, precedent-grounded classification.

### Negative

- 27.3 is a near-empty implementation PR — legitimate and honest for a tier that was already
  minimal, but unusual for a backlog item phrased as a minimisation.
- The tier's backstop is the weakest of the three: no coverage aggregate, no mutation signal,
  and no cross-tool byte-compare catches a silently dropped unique `(journey, engine)` pair, so
  construction-proof + reviewer diff-reading carry the whole guarantee. This binds future E2E
  minimisation work, not this no-op PR.

### Neutral

- The `for…of` collapse idiom and the engine-as-distinguishing-input rule are documented for
  any future E2E growth; 27.3 itself applies them to nothing.
- The parity carve-out being drawn by *mechanism* rather than directory is specific to this
  tier (its scope is a single directory that also houses the driver); the unit and integration
  tiers keep their directory-based carve-outs.
