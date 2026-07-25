# 506 — Test-convention conformance sweep: axes, criteria, and count-preservation

- **Status:** accepted (user judgment — ratified the design's recommendations, with two
  deviations the user chose directly)
- **Date:** 2026-07-25
- **Design:** docs/design/test-convention-sweep.md · **Refines/Supersedes:** none
  (new standing methodology; complements ADR-110 `sut` naming, ADR-112/114–116 AAA
  markers, ADR-105 directory-based classification, ADR-108 pyramid-audit tooling,
  ADR-134/136 property-tests-as-additive-siblings, and ADR-498 KEEP/COLLAPSE discipline)

## Context

Backlog 27.6 aligns legacy test files to the project test convention (CLAUDE.md
§Test Conventions) across **three axes** — `sut`/`result` naming, AAA body markers,
and Given/When/Then structure — over **all** test tiers (`test/**`) in one PR. The
user broadened the original "`sut`/`result` naming sweep" to include AAA and GWT
structure, with **zone regrouping** (cluster tests sharing the same Given+When into
one describe zone per subject+event).

This is a **behaviour-preserving conformance sweep**, not a behaviour change and not
a minimisation: no assertion changes, no `src/` change. Two facts fix the proof model:

- **CI PR mutation is zero-signal for a test-only PR** (`compute-mutation-scope.sh`
  filters the diff to `^src/.*\.ts$`; an empty mutate-list means Stryker audits
  nothing). Local whole-tree Stryker under-reports non-deterministically
  (stryker-js#5928). Proof is by construction + coverage + green `validate`.
- **The machine gate (`check:test-pyramid`) only partly covers the axes.** Its
  heuristics (`gwtTitle`, `aaaBody`, `emptyAaaSection`, `sutNaming`, …) are all
  `tier: 'unit'`, and `sutNaming` checks only the *identifier* is `sut` / bans aliases
  — it does **not** check `sut` binds the unit rather than the outcome, and does **not**
  require a `sut` binding to be present. So axis-1 *semantics* and every *non-unit tier*
  rest on the per-file procedure + the review phase, not the gate.

## Options considered

### Standing ADR vs doc-only vs fold-into-498
1. **New standing ADR (this document)** (chosen) — a reusable conformance contract with
   a durable home. / 2. doc-only (the axis-1-un-gated/review-proven contract drifts);
   3. fold into ADR-498 (498 is *minimisation*/count-reducing; this is *conformance*/
   count-preserving — different invariant, dilutes both).

### `sut` form for a pure free function / static factory (recurs hundreds of times)
1. **Strict: `const sut = crc32; const result = sut(data)`** (design recommendation) —
   `sut` = the reference, uniform with the `map.test.ts` north star.
2. **Pragmatic: drop `sut`; `const result = crc32(data)`** (**chosen — user judgment**) —
   for a one-liner whose callee self-names the unit, bind the outcome to `result` with no
   intermediate `sut`. The gate permits an absent `sut` (`sutNaming` requires no binding);
   object-under-test tests still keep `sut`.

### Parameterisation policy
1. **Regroup only; preserve every `it` leaf** (design recommendation).
2. **Collapse same-act/same-oracle leaves into `it.each`** (**chosen — user judgment**),
   under ADR-498 guard-rails, **but restricted to lossless COLLAPSE — no DELETE** (see
   Decision below). 3. Never parameterise.

### Batching granularity + ordering (run-specific)
1. **Per-subsystem directory + per-file for the giants; machine-gated unit tiers first
   (domain → operators/ports/adapters → small non-gated unit → application), un-gated
   non-unit tiers (integration → parity/runtime-parity/perf) last** (chosen). / 2. per-tier
   mega-parts (un-reviewable); 3. per-file uniformly (~340 parts, overhead dominates).

## Decision

**The three conformance axes (standing).**

1. **Axis 1 — `sut`/`result`.** `sut` binds the *unit under test*; the *outcome* binds
   `result`. **User deviation (chosen):** for a **pure free function** or a **`this`-free
   static factory** (`crc32`, `ObjectId.from`, `RefName.from`, `FilePath.from`), **drop the
   `sut` binding** and bind the outcome directly — `const result = crc32(data)`,
   `const result = ObjectId.from(hex)`. An **object/factory under test** keeps `sut` (the
   object is the unit): `const sut = new NodeHashService('sha256'); expect(sut.digestLength)…`,
   `const sut = openRepository(…); const result = await sut.status()`. The **anti-pattern
   fixed** is `const sut = <call>(…)` where `sut` holds the *outcome* and is only read as
   data. Test *input* never binds to `sut`. A throwing/rejecting test keeps the error
   assertion on `.data` (never a bare `toThrow(Class)` — gated by `bareClassToThrow`).

2. **Axis 2 — AAA markers.** Every non-skipped `it`/`test` body carries `// Arrange`,
   `// Act`, `// Assert` (all three; the gate floor is `Arrange`+`Assert`). A genuinely
   empty section uses a compound marker (`// Arrange & Act`) — never a bare marker above an
   empty section (`emptyAaaSection` gate). `it.each` object-row field is **`label`**, never
   `then` (`noThenProperty`).

3. **Axis 3 — GWT structure with zone regrouping.** `describe('Given …')` >
   `describe('When …')` > `it('Then …')`; the 2-level shortcut only for a singleton When.
   **Cluster** every test sharing the *same Given AND same When* into **one** describe zone
   per subject+event. A zone boundary is crossed iff the Arrange (Given) or the invocation
   (When) genuinely differs. Regrouping **moves** `it` leaves between describes; it never
   changes a leaf's assertions.

**Count discipline (standing) — the user constraint "do not remove, change, add tests".**
Reusing ADR-498's classification with one restriction:

- **KEEP** verbatim (with the axis-1/2/3 conformance edits applied) if act OR oracle
  differs from every sibling, or it isolates a guard/boundary no sibling isolates.
- **COLLAPSE** 3+ siblings sharing the same act AND oracle shape into one `it.each`, where
  the row matrix is the **union** of every sibling's distinguishing inputs and expected
  oracles — no input dropped, no oracle weakened. Collapse is **lossless**: every original
  input case survives as a row (the `it()`-block count may drop; the *case* count does not).
- **NO DELETE.** ADR-498's strict-subset DELETE is **excluded** — "do not remove tests"
  forbids dropping any test case, even a redundant one. Every distinguishing input survives
  as a KEEP leaf or a COLLAPSE row. No net-new test case is added.

**Guard-rails (standing, from ADR-498).** A collapse is illegal — revert to KEEP — if it
would drop a distinguishing/boundary input, merge two guard conditions of an `if (A || B)`
into one row, weaken an error assertion, or share mutable state across `it.each` rows.
`.skip`/`.todo`/`.fails` blocks are left verbatim. `*.properties.test.ts` files conform
*structure* only — the `fc.property(…)` invariant and arbitraries are byte-preserved
(ADR-134/136: properties are additive and non-substitutable).

**Proof model (standing).** Behaviour preservation is proven **by construction** (every
Arrange→Act→Assert triple and its `expect(…)` is preserved 1:1; a collapse re-expands to N
independent runs; no triple is deleted) + `npm run test:coverage` (100%, cannot drop — no
case removed) + green `npm run validate` (full multi-tier suite + `check:test-pyramid`).
**Axis-1 semantics and non-unit-tier conformance are proven by the review phase** (its named
focus), since the gate does not cover them. Mutation gates nothing here (zero-signal).

**Batching (run-specific to 27.6).** One part per subsystem directory, a dedicated part per
giant file, ordered machine-gated unit tiers first (domain → operators/ports/adapters →
small non-gated unit → application) then un-gated non-unit tiers (integration →
parity/runtime-parity/perf) last, so the procedure is proven where the pyramid gate is
strongest before reaching the tiers it does not cover.

## Consequences

- The methodology is mechanical and reviewable: a reviewer verifies the *discipline*
  (sut-binds-the-unit-or-is-dropped-per-rule, matrix-is-union, no weakened oracle, no case
  removed) by reading the diff — not a mutation score.
- No `src/` change: git-faithfulness (ADR-226) is untouched by construction; no
  threshold/budget file (`test-pyramid-budgets.json`, `mutation-budgets.json`) moves.
  Collapsing lowers `it()`-block counts, which the budgets bound as maxima — still satisfied.
- Axis 1 lands **without** a `sut` binding on the many pure-function/static-factory tests
  (user deviation); this is intentional non-uniformity with object-under-test tests and is
  permitted by `sutNaming`.
- The non-unit tiers carry no GWT/AAA/`sut` gate, so the review phase is the safety net
  there and is sequenced to weight it accordingly.

## Harness extension — lock the convention in for every tier (user-requested)

The user asked that the structure be **enforced in future for every kind of test**, closing
the "non-unit tiers have no gate" gap above. This extends `check:test-pyramid`
(`tooling/test-pyramid/`, `test-pyramid-budgets.json`) — a **tooling change** (not `src/`,
so CI mutation stays zero-signal; proven by the detectors' own `tooling/test/unit/test-pyramid/`
unit tests via TDD).

### Decision E — extend the four structural detectors to all tiers, gating (user judgment)

`gwtTitle` (`detect-bad-title`), `aaaBody` (`detect-missing-aaa`), `emptyAaaSection`
(`detect-empty-aaa-section`), and `sutNaming` (`detect-banned-sut-name`) move from
`tier: 'unit'` to **all tiers** (`unit`, `integration`, `parity`, `runtime-parity`, `perf`)
and are **blocking**. Mechanism: the manifest heuristic gains a `tiers` set (superseding the
single `tier`); each detector's `classifyTestFile(...) !== heuristic.tier` skip becomes a
membership check `!heuristic.tiers.includes(classifyTestFile(...))`; the detectors' unit
tests extend to cover multi-tier classification. `bareClassToThrow` and `underAssertedUnit`
extend on the same mechanism where they read cleanly; tier-specific heuristics
(`integrationProof`, `overMockedIntegration`) are untouched.

### Decision F — add a best-effort axis-1 detector `sutBindsResult`, gating (user judgment)

A new detector (`detect-sut-binds-result.ts` + sibling test) flags the seeding smell:
`const sut = <bare-call>(…)` where `sut` binds a *call result*. It **allows** `const sut = new X(…)`
(object under test) and a **factory allowlist** (`openRepository`, `createX`, … — the
`this`-carrying factory calls that legitimately return the object under test). It is
best-effort and heuristic: false positives are handled by extending the allowlist with a
one-line reason, never by suppressing the finding. Gating, all tiers. This is the forward
enforcement of Axis 1, which the name-only `sutNaming` cannot cover.

### Ordering invariant (non-negotiable) — conform, THEN gate

A gate flips on only once its tier is **100% conformant**, else `validate` goes red. So the
harness-extension parts land **after every conformance part** (all tiers swept). Concretely:
extend/add the detectors → run `check:test-pyramid` against the fully-conformed tree and fix
any straggler it surfaces (the detector is the final backstop that proves the sweep complete)
→ flip `gating` to blocking last. The new-detector work is proper TDD (detector unit test
red → green); a new detector source file is added to biome's `includes` whitelist in the same
part (else it is silently unlinted).

### Consequences of the extension

- The three axes are enforced **forever, on every tier** — the durable value the sweep
  banks on. `sutBindsResult` turns the once-off axis-1 review into a standing gate.
- `sutBindsResult` is heuristic; the factory allowlist is the escape hatch and is itself
  reviewed. It will not catch every semantic misuse, but it catches the exact
  `const sut = call()` shape that seeded 27.6.
- Budgets/thresholds files still do not move for the *counts*; only the heuristics' tier
  reach and the `gating` set change, plus one new heuristic entry.
