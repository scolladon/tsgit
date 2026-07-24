# E2E test minimisation — one Playwright flow per distinct browser journey/capability

> Brief (27.3): "Each Playwright / browser flow asserts a user journey no other
> E2E flow asserts. Parity cross-products excluded from the overlap audit."
> Status: draft → self-reviewed ×3 → accepted

## Goal & scope

Reduce the **E2E tier** to **one Playwright flow per distinct user journey /
browser capability** without losing a single asserted journey, a single
browser-engine probe, or touching a single parity golden. This is the E2E-tier
analog of the shipped 27.1 unit-tier (`docs/design/unit-test-minimisation.md`,
ratified as [ADR-498](../adr/498-unit-test-minimisation-methodology.md)) and 27.2
integration-tier (`docs/design/integration-test-minimisation.md`, ratified as
[ADR-499](../adr/499-integration-test-minimisation-tier-deltas.md)). The same two
mechanical moves do the reduction:

- **Collapse** flows that assert the *same journey with different inputs* into one
  parameterised case.
- **Delete** flows whose journey and assertions are a *strict subset* of a flow
  that remains.

Everything else is **kept verbatim**. Because this is the same methodology, this
doc **does not re-derive** the classification/proof reasoning — it *refines* it
for the E2E tier, as ADR-499 did for integration. ADR-498 already names 27.3 as
an inheritor. The load-bearing differences from 27.1/27.2 are five, each
addressed below:

1. **No coverage gate, no mutation signal, and no pyramid-heuristic gate — E2E is
   invisible to all three.** `test:coverage` runs the `unit` vitest project only;
   Stryker mutates `src/` against **unit** tests and never loads a Playwright
   spec; the pyramid shape heuristics are unit-scoped. E2E drives *no* mechanical
   correctness number at all (§4).
2. **The collapse idiom is a `for…of` loop over `test()` / `test.describe()`, not
   vitest `it.each`.** Playwright has no `it.each`; parameterisation is a bespoke
   loop that emits one `test()` per row — the pattern `parity.spec.ts` already
   uses over `SCENARIOS`. `test.step` granularity on a kept flow is preserved
   (§2).
3. **A new distinguishing axis: the browser *engine* (chromium / firefox /
   webkit).** WebKit's headless Playwright build exposes no OPFS
   (`navigator.storage.getDirectory`), so every OPFS-backed flow skips webkit. A
   flow that is the *sole* executor on an engine is never deleted/collapsed —
   engine coverage is a distinguishing input, like a boundary value (§3.2).
4. **The parity carve-out now lives *inside* the tier's own directory.** For 27.2,
   `test/browser/**` was carved out wholesale as a sibling directory. For 27.3 the
   E2E scope *is* `test/browser/**`, so the carve-out must be drawn by
   **mechanism** — the cross-adapter scenario *driver* — not by directory (§"The
   parity carve-out").
5. **The backstop is construction-proof + browser-engine-preservation review +
   green `test:e2e`, with CI as the green authority.** Coverage/mutation/pyramid
   being all zero-signal, reviewer diff-reading carries even more weight than in
   27.2 (§3).

**Scope (user decision, non-negotiable — Decision 4): the whole E2E tier in ONE
PR** — the 4 bespoke spec files under `test/browser/`. The exact surface, from
`playwright.config.ts` (`testDir ./test/browser`, `testMatch *.spec.ts`, projects
`chromium` / `firefox` / `webkit`):

| Spec file | bespoke `test()` cases | runs on webkit? | in 27.3 audit? |
|---|---:|---|---|
| `opfs-roundtrip.spec.ts` | 1 | no (OPFS-skipped) | **yes** |
| `hash-interop.spec.ts` | 2 | (a) yes · (b) no | **yes** |
| `decompression-stream.spec.ts` | 3 | yes (all 3) | **yes** |
| `surface-parity.spec.ts` | 6 | no (OPFS-skipped) | **yes** |
| `parity.spec.ts` (registry guard + `SCENARIOS`×browsers driver) | 1 + 34 | no (OPFS-skipped) | **NO — carve-out (§"The parity carve-out")** |

That is **12 bespoke `test()` cases across 4 files** plus the parity driver. Only
**1** E2E file parameterises today — `parity.spec.ts`, whose `for (const scenario
of SCENARIOS)` loop is the in-repo exemplar of the Playwright collapse idiom
(§2). Support files (`fixtures.ts`, `index.html`, `serve.mjs`,
`parity-scenarios.bundle.ts`) hold no `test()` and are never a comparand.

### The parity carve-out — cross-adapter equivalence ≠ user-journey coverage

The backlog draws this line itself. 27.2's entry says, verbatim, that the parity
cross-products *"(Node × Memory × Browser × Deno × Bun × Workers) are **NOT
overlap** — they prove cross-adapter equivalence and stay distinct."* ADR-499
restated it as a non-negotiable: `test/parity/**`, `test/runtime-parity/**`, and
`test/browser/**` are *"never … counted as a retained test that could make [a]
test a strict subset."* 27.3's brief carries the identical clause forward:
*"Parity cross-products excluded from the overlap audit."*

Two proofs live in `test/browser/**` and must not be confused:

- **The cross-adapter parity DRIVER (the carve-out, never touched).**
  `parity.spec.ts` looks each scenario up by name in the browser bundle
  (`window.__tsgitParity`, ADR-127), runs it against an OPFS-backed `Repository`,
  and asserts the result equals the scenario's shared `expected` golden. The Node
  driver (`test/parity/node.test.ts`) and Memory driver
  (`test/parity/memory.test.ts`) assert the **same** golden — divergence is a
  parity bug. Its whole reason to exist is the `{chromium, firefox, webkit} × 34
  scenarios` cross-product against a golden shared across adapters; collapsing it,
  deleting any scenario run, or **counting it as a retained test that covers a
  bespoke journey** would destroy the cross-adapter proof. `parity.spec.ts` +
  `parity-scenarios.bundle.ts` are the carve-out. Its registry-completeness guard
  test stays too.
- **The bespoke journey / capability FLOWS (the audit set).** The other 4 files
  assert *user journeys* and *engine capabilities* through the browser facade on
  the real engine — richer per-`test.step` assertions, engine-capability probes,
  a typed refusal. These are the auditable E2E flows.

**The boundary is the driver mechanism, not the filename.** `surface-parity.spec.ts`,
despite its name, is **not** the cross-adapter driver — it is 6 bespoke
single-command journeys and is **in** the audit. This mirrors ADR-499's inverse
note ("`-parity`-named files *inside* `test/integration/**` are cross-tool interop
and in scope; the carve-out is by directory, not filename"): here the carve-out is
the SCENARIOS-driving mechanism (`parity.spec.ts`), not anything named "parity".

## The invariant: behaviour-preserving, tests only

**No `src/` change.** This is a pure test-suite refactor. Production code, object
SHAs, ref/reflog contents, on-disk state files, refusal conditions and message
formats are untouched, so the git-faithfulness prime directive
([ADR-226](../adr/226-git-faithfulness-prime-directive.md)) is unaffected by
construction. No new git behaviour is pinned here: every bespoke flow already
encodes an *observed* browser-adapter behaviour, and every parity golden already
encodes an *observed* cross-adapter result; minimisation only re-groups or drops
duplicated observations, it never invents or relaxes one. The
empirical-pinning procedure (`.claude/workflow/faithfulness.md`) therefore does
not apply — this design was pinned against reality by **reading the real spec
files and the real scenario goldens** (the audit table below is verified against
them), not against memory of an external system.

The property we preserve across every edit, restated for the E2E tier (the 27.1
property plus a browser-engine clause):

> **The multiset of asserted `(journey, engine)` pairs the E2E tier proves does
> not shrink; no assertion is weakened; and every surviving flow that ran against
> a real browser engine still runs against that same engine.**

The engine clause is what a careless delete could silently erode here: dropping a
flow that was the *only* assertion running on webkit (the SubtleCrypto /
DecompressionStream capability probes) would keep the suite green while zeroing
webkit E2E coverage of that capability. That is the E2E-tier equivalent of a
resurrected mutant, and §3.2 is the check for it.

## Why the outcome bar cannot be freshly *measured* (and what we do instead)

27.1 leaned on coverage (measurable) + mutation (proven by construction); 27.2
lost coverage and leaned on cross-tool preservation. **For the E2E tier, every
mechanical correctness signal is dark:**

- **Coverage — not driven by this tier at all.** `npm run test:coverage` runs
  `vitest run --project unit --coverage` over
  `src/{domain,ports,adapters/node,adapters/memory,operators}/**`. Playwright is
  not a vitest project; the browser adapter (`adapters/browser`) is not even in
  the coverage `include` set. A deleted E2E flow can never move a coverage number
  — coverage is **zero-signal** here, exactly as in 27.2 but more so.
- **Mutation — doubly zero-signal.** The PR mutation job
  (`tooling/run-stryker-pr.ts` ← `compute-mutation-scope.sh`) scopes Stryker to
  the diff filtered by `grep -E '^src/.*\.ts$'`; a tests-only change mutates
  nothing ⇒ "No src/ files … skipping" ⇒ exit 0. And Stryker mutates `src/`
  against the **unit** suite only — it never loads a Playwright spec, so even a
  full local sweep audits nothing about E2E. No mutation evidence exists for this
  PR.
- **The pyramid GWT/AAA/`sut` heuristics — do not gate E2E.** In
  `test-pyramid-budgets.json` every gating heuristic is `tier: unit`; there is no
  gating E2E-tier heuristic. `check:test-pyramid` mechanically gates **nothing**
  on the shape of a Playwright `test()`.

**What remains, and is therefore load-bearing (§3):**

1. **Proof-by-construction** — the same union/strict-subset theorem: a collapse
   relocates every asserted journey 1:1, a delete removes only strict-subset
   journeys (§3.1).
2. **Browser-engine preservation** — each surviving flow still runs against the
   same real engine(s) via `page.evaluate`, and every `(journey, engine)` pair
   kept (§3.2). This is the E2E-specific obligation standing in for
   coverage/mutation.
3. **Green suite** — `npm run test:e2e` (`npx playwright test`, all 3 projects)
   proves the surviving flows pass (§3.3). Like 27.2's `test:integration` it is
   weaker than a coverage aggregate: green proves surviving journeys pass, **not**
   that no unique journey was silently dropped — so §3.1 construction + reviewer
   diff-reading carry the guarantee.
4. **Parity goldens unchanged** — `parity.spec.ts`, `parity-scenarios.bundle.ts`,
   and everything under `test/parity/**` stay byte-identical (§3.4). The
   cross-adapter proof is untouched by construction.
5. **`biome check`** — the one machine gate that *can* bind a collapsed shape: if
   a collapse uses object rows, `noThenProperty` forbids a `then` key (row field
   `label`), on every touched file in the part gate (§2).

This shift — every correctness number dark, browser-engine-preservation +
construction promoted to the primary backstop — is Decision 2.

## 1. Operational classification — KEEP / COLLAPSE / DELETE

Reuse ADR-498's procedure, with "act/oracle" reinterpreted for E2E. Define, for a
bespoke flow `T`:

- its **journey** — the sequence of user-facing repo operations (or the engine
  capability) under test through the browser facade (e.g. "init → add → commit →
  status on OPFS", "SubtleCrypto SHA-1 of a canonical blob frame == git golden",
  "ssh clone → typed `ADAPTER_UNAVAILABLE` refusal");
- its **oracle** — the `expect(…)` assertion *shape*, ignoring literals (e.g.
  "commit id is 40-hex on refs/heads/main", "typed `TsgitError` with
  `data.code === 'DECOMPRESS_FAILED'`", "note content round-trips then reads null
  after remove");
- its **distinguishing inputs** — the concrete inputs that make `T` differ from
  its siblings, *and* — uniquely to this tier — the **browser engine(s)** it runs
  on (webkit-gated or not).

```
For each group of bespoke flows that share ONE journey under a common —
or unifiable (§2) — Given+When:

  (a) KEEP verbatim
      if the flow's journey OR oracle differs from every sibling
      (a different command/capability, a structurally different assertion,
      a different typed refusal), OR it is the SOLE flow asserting a
      (journey, engine) pair (e.g. the only webkit-running probe of a
      capability).

  (b) COLLAPSE into one for…of-generated test()
      if 3+ siblings assert the SAME journey AND the SAME oracle SHAPE,
      differing only in the row inputs. The row matrix MUST be the UNION of
      every sibling's distinguishing inputs AND engine-gating — no input
      dropped, no assertion weakened, no engine coverage lost.

  (c) DELETE
      if T's (inputs × assertions × engines) is a STRICT SUBSET of a single
      retained bespoke flow R: every input T exercises R exercises, every
      assertion T makes R makes, and every engine T runs on R runs on.
      Removing T removes no unique (journey, engine) pair.
      The parity DRIVER is NEVER an R (§"The parity carve-out").
```

**"Distinct journey" precisely** = a different command/capability, a structurally
different `expect`, a different typed refusal, or a `(journey, engine)` pair no
other kept flow asserts. **"Strict subset" precisely** = containment in *all
three* dimensions (inputs, assertions, engines) against **one** retained *bespoke*
flow — the parity driver is excluded from the comparand set, so it can never be
the `R` that makes a bespoke flow a subset.

### 1.1 The complete audit table (verified against the real specs + goldens)

Journeys are read off the actual assertions; the parity-overlap column names the
`SCENARIOS` entry (if any) that asserts the same journey on the browser adapter.
The two verdict columns are the pivotal interpretation (Decision 1): **Reading A**
counts the browser parity run as covering a journey; **Reading B** excludes parity
from the audit entirely (the recommended reading, per the backlog/ADR-499
precedent that parity is "NOT overlap … stay distinct").

| # | Flow (file · case) | Journey asserted | Engine(s) | Parity-scenario asserting same journey on browser | Verdict — Reading A | Verdict — Reading B |
|---|---|---|---|---|---|---|
| T1 | `opfs-roundtrip` · init→add→commit→status | porcelain write path, asserted per `test.step` (init main/non-bare · add stages a.txt · commit 40-hex on refs/heads/main · status clean+attached) | chromium, firefox | **`init-add-commit-status`** (same field shape + exact golden SHA, browser) — but seeds `'hello a\n'`/`'seed commit'` vs T1's `'hello browser\n'`/`'first browser commit'` | **DELETE** — *redundant journey* (parity covers init→add→commit→status on the browser; T1's differing seed/message is non-distinguishing). **Not a literal strict subset** — inputs differ | **KEEP** — sole *bespoke* asserter of this journey; parity is a different axis, excluded |
| T2 | `hash-interop` (a) · SubtleCrypto SHA-1 | `BrowserHashService.hashHex` of `blob <n>\0hello\n` == git golden `ce0136…`; pure capability, no repo/OPFS | **chromium, firefox, webkit** | none (no scenario hashes a hand-framed blob via the raw hash service) | **KEEP** | **KEEP** |
| T3 | `hash-interop` (b) · writeObject→readBlob | blob written via facade, read back byte-exact (`readBlob(id).content` == input) | chromium, firefox | `write-pipeline` overlaps the **write half** (golden `blobId` + `streamBlob` byte-*length*) but asserts **no** `readBlob` content compare | **KEEP** — the readBlob content round-trip is unique (streamBlob length ≠ readBlob content equality) | **KEEP** |
| T4 | `decompression-stream` (a) · deflate→inflate | `BrowserCompressor` round-trip byte-identity; pure capability | **chromium, firefox, webkit** | none | **KEEP** | **KEEP** |
| T5 | `decompression-stream` (b) · error path | non-zlib bytes → typed `TsgitError` `DECOMPRESS_FAILED`; pure capability | **chromium, firefox, webkit** | none | **KEEP** | **KEEP** |
| T6 | `decompression-stream` (c) · multi-member streamInflate | >64 KiB member + a second member → exact output + `bytesConsumed` per member; pure capability | **chromium, firefox, webkit** | none | **KEEP** | **KEEP** |
| T7 | `surface-parity` · log | 2 commits newest-first + parent linkage | chromium, firefox | none (no `log` scenario; `read-pipeline` asserts a walk *count* on a 1-commit repo, not ordering/parents) | **KEEP** | **KEEP** |
| T8 | `surface-parity` · branch | branch create→list→delete lifecycle (incl. `current` flag) | chromium, firefox | **`branch-lifecycle`** (same lifecycle + exact golden ids, browser) — but `seedRepo` seeds `'hello browser\n'` vs the scenario's `'hello a\n'`, so the branch/commit SHA differs | **DELETE** — *redundant journey* (differing seed content is non-distinguishing for the lifecycle). **Not a literal strict subset** — inputs differ | **KEEP** |
| T9 | `surface-parity` · checkout | divergent branches materialise working file v1/v2 | chromium, firefox | none (no checkout-materialise scenario; `sparse-checkout` is a different journey) | **KEEP** | **KEEP** |
| T10 | `surface-parity` · tag | tag create→list→delete lifecycle | chromium, firefox | none (no `tag` scenario) | **KEEP** | **KEEP** |
| T11 | `surface-parity` · notes | notes add→list→read→remove lifecycle | chromium, firefox | **`notes`** (same lifecycle + same oracle shape, browser) — but seeds `'hello browser\n'` + note `'browser note'` vs the scenario's `'hello a\n'` + `'parity note'` | **DELETE** — *redundant journey* (differing seed/note text is non-distinguishing). **Not a literal strict subset** — inputs differ | **KEEP** |
| T12 | `surface-parity` · ssh-clone-refusal | ssh clone → typed `ADAPTER_UNAVAILABLE`, no network touched | chromium, firefox | none (browser-adapter capability refusal; parity runs the same scenarios on Node/Memory, which do not share this refusal) | **KEEP** | **KEEP** |
| — | `parity.spec.ts` (registry guard + 34 scenarios × browsers) | cross-adapter equivalence on the browser axis vs a golden shared with Node/Memory | chromium, firefox | *is* the parity cross-product | **CARVE-OUT** — untouched, but *used as a cover* to justify T1/T8/T11 deletes | **CARVE-OUT** — untouched, *not a comparand*; covers nothing |

**A load-bearing precision: none of T1/T8/T11 is a *literal* strict subset.** Each
seeds `'hello browser\n'` (via the inline write or `seedRepo`) whereas its parity
counterpart seeds `FILES.helloA` = `'hello a\n'` — and T1 further differs on the
commit message, T11 on the note text. So each bespoke flow exercises a concrete
input its parity scenario never runs; the resulting SHAs differ (which is exactly
why the bespoke flows assert a 40-hex *regex*, not the golden). Under the strict
ADR-498 definition, DELETE requires input-containment, which **fails** here — the
strict methodology deletes nothing. Reading A's three deletes therefore rest
*entirely* on treating seed content / message / note-text as a **non-distinguishing
input for the journey** (the journey shape is input-independent). That is a
coherent but genuinely *looser* reading than 27.1/27.2 applied — a fact that
weighs toward Reading B (Decision 1).

**No COLLAPSE candidates exist under either reading.** Every group that looks
collapsible fails the same-act/same-oracle test:

- The 3 `decompression-stream` flows assert **structurally different oracles**
  (round-trip byte match / typed error / multi-member `bytesConsumed`) → KEEP-distinct.
- `hash-interop` (a) and (b) have **different acts** (raw `BrowserHashService`
  vs facade `writeObject`/`readBlob`), **different oracles**, and **different
  engine-gating** ((a) runs webkit, (b) is OPFS-skipped) → KEEP-distinct (see
  Decision 3).
- The 6 `surface-parity` flows are **6 different commands** (log/branch/checkout/
  tag/notes/ssh) with different acts and oracle shapes; `branch` and `tag` share a
  *create→list→delete* silhouette but call **different SUT namespaces**
  (`repo.branch.*` vs `repo.tag.*`) and `branch` uniquely asserts the `current`
  flag → KEEP-distinct.

So the only reduction on the table is **Reading A's three DELETEs (T1, T8, T11)**.
Under **Reading B the bespoke set has zero cross-bespoke overlap — the E2E tier is
already minimal**, and 27.3 is a *confirming audit* that deletes nothing (§5).
This is the honest, precedent-grounded outcome, not a shortfall: the tier was
constructed one-flow-per-capability across phases 16.3–16.4 and 19.5, with parity
as the deliberately separate cross-adapter axis.

## 2. GWT discipline & the Playwright collapse idiom — by convention + biome

No pyramid heuristic gates a Playwright `test()` (§"Why the outcome bar…"), and
E2E specs already diverge from unit-tier GWT: they use `test`/`test.describe`/
`test.step`, bind `result` / `contents` / `entries` rather than `sut`, and put
Given/When/Then in the `test()` title string. **Minimisation preserves each
file's existing convention exactly — the bar is "no worse than today", not a
retrofit of unit-tier GWT onto Playwright.** The one machine gate that binds a
collapsed shape is biome `noThenProperty` (row field `label`, never `then`), via
`biome check` in the part gate.

**The collapse idiom is a `for…of` loop, not `it.each`.** Playwright has no
`it.each`; the in-repo pattern (`parity.spec.ts`) is:

```
for (const row of MATRIX) {                       // MATRIX = union of merged flows
  test.describe(`Given the ${row.label} …`, () => {
    test('Then <the shared oracle> holds', async ({ readyPage }) => {
      // Arrange — build THIS row's OPFS state via page.evaluate (per-row, isolated)
      // Act     — run the shared journey against the real engine for this row
      // Assert   — the shared oracle, expected from the row
    });
  });
}
```

`test.step` granularity on a **kept** flow (opfs-roundtrip's per-operation steps,
surface-parity's per-assertion steps) is preserved verbatim — it is the flow's
error-localisation contract, not overlap (Decision 3b). Per-flow isolation is
already handled by the `readyPage` fixture (`goto` harness → `resetOpfs`); a
collapse keeps that fixture and never hoists mutable OPFS state across rows
(OPFS persists for the page lifetime, so each row must reset or re-seed exactly as
today). Because **no bespoke collapse candidate exists** (§1.1), this idiom is
documented for completeness and for any future E2E growth; 27.3 itself applies it
to nothing.

## 3. Invariant-preservation proof obligation (per part)

### 3.1 Journey preservation — by construction (primary, unchanged from ADR-498)

A journey is proven by the E2E tier **iff at least one flow asserts it on at least
one engine**. The two moves preserve every `(journey, engine)` pair:

- **COLLAPSE** relocates each sibling's Arrange/Act/Assert into a row 1:1; the
  `for…of` re-emits N independent `test()` runs ⇒ the multiset of asserted
  `(journey, engine)` pairs is identical pre/post, **provided the matrix is the
  union of all inputs and engine-gating and no oracle is weakened**.
- **DELETE** removes only a flow whose `(inputs × assertions × engines)` is a
  strict subset of a retained **bespoke** flow ⇒ removes no unique pair.

The reviewer verifies the *discipline* by reading the diff — union-of-inputs,
delete-is-strict-subset, no weakened oracle, no lost engine — exactly as in
27.1/27.2.

### 3.2 Browser-engine preservation (the E2E-specific obligation)

The backstop that *replaces* 27.1's coverage+mutation and 27.2's cross-tool
compare. A collapse/delete is **illegal** (revert to KEEP) if any holds:

- **It drops a `(journey, engine)` pair.** The webkit-running probes (T2 SHA-1;
  T4/T5/T6 decompression) are the **only** E2E assertions that execute on webkit —
  every OPFS flow skips it. Deleting or webkit-gating any of them zeroes webkit
  capability coverage. Engine is a distinguishing input; a flow that is the sole
  executor on an engine is never removed. The `test.skip(browserName ===
  'webkit', …)` and OPFS-skip guards are preserved **byte-exact** on every kept
  flow.
- **It weakens a typed-refusal / error assertion.** T5's `data.code ===
  'DECOMPRESS_FAILED'` and T12's `ADAPTER_UNAVAILABLE` keep their exact `data`
  fields; never collapse to a bare `caught === true`. (Mirrors ADR-226 +
  ADR-498's error-data rule.)
- **It counts the parity DRIVER as a cover.** Under the recommended reading the
  parity browser run is never the retained `R` (§"The parity carve-out"); the
  Reading-A verdicts in §1.1 are the *only* place parity-as-cover appears, and
  they are gated behind Decision 1.
- **It shares mutable OPFS state across `for…of` rows** — each row's Arrange stays
  self-contained inside its `page.evaluate`; the `readyPage` fixture's
  `resetOpfs` per test is preserved.

### 3.3 Green suite — measured (backstop, weaker than a coverage aggregate)

`npx playwright test <touched spec>` per part (where the browser toolchain is
available) and `npm run test:e2e` at the boundary prove every surviving flow
**passes** across all 3 projects. Like 27.2's `test:integration` this is strictly
weaker than a coverage aggregate: green confirms surviving journeys pass but —
with no coverage number — cannot detect a *silently dropped* unique journey. That
gap is closed only by §3.1 construction + §3.2 review of the diff. **CI is the
green authority** for engines the local host cannot exercise reliably (the darwin
host's headless webkit lacks OPFS; browser installs vary), exactly as the CI
`win-integration` job was 27.2's authority for `win-only/` — an implementer must
not claim a partial local run proves a cross-engine collapse.

### 3.4 Parity goldens unchanged (honoured by construction)

`parity.spec.ts`, `parity-scenarios.bundle.ts`, and every
`test/parity/scenarios/*.scenario.ts` golden (e.g. the
`fa8b886eee0d470d870e786878657cac05d686e6` init-add-commit-status SHA) stay
**byte-identical**. 27.3 touches only bespoke spec files (or, under Reading B,
none). No golden moves, so the cross-adapter proof and its Node/Memory drivers are
untouched.

### 3.5 Targeted hand-verification (backstop for risky edits)

For any delete the reviewer judges risky, confirm the retained flow still detects
a regression: under Reading A, before deleting T1/T8/T11, confirm the *parity*
browser run of the corresponding scenario **fails** when the asserted field is
perturbed (deterministic single-scenario run:
`npx playwright test parity.spec -g '<scenario>'`), proving the journey is truly
still asserted after the bespoke flow is gone. Under Reading B nothing is deleted,
so this obligation is vacuous.

### 3.6 What we explicitly do NOT rely on

Coverage (E2E drives none), CI PR mutation (zero-signal), local Stryker (never
loads a Playwright spec), and the pyramid GWT/AAA heuristics (unit-scoped). §3.1
construction + §3.2 engine preservation + §3.3 green + §3.4 goldens-unchanged +
§3.5 hand-verify are the proof.

## 4. Carve-outs and property tests

- **The cross-adapter parity driver is out of scope.** `parity.spec.ts` +
  `parity-scenarios.bundle.ts` (and everything under `test/parity/**` /
  `test/runtime-parity/**`) are **left byte-identical** — never collapsed,
  deleted, nor (under the recommended reading) counted as a retained flow that
  could make a bespoke flow a subset. They prove cross-adapter equivalence, which
  is destroyed by collapsing across adapters/engines.
- **`*.properties.test.ts` do not exist in this tier** (Playwright specs are
  `*.spec.ts`); the ADR-134/136 property carve-out is vacuous here but the rule
  stands.
- **`test.skip(browserName === 'webkit', …)` guards and the `readyPage` /
  `seedRepo` fixtures** are left verbatim — the engine-skip gating is preserved
  exactly so each flow no-ops cleanly where OPFS is absent.

## 5. Partitioning & ordering (for the plan phase)

Keyed to the chosen reading (Decision 1):

- **Under Reading B (recommended): zero test parts.** The audit finds no
  cross-bespoke overlap, so no spec file is touched. The PR is the design doc +
  ADR-500 + the backlog tick; the implementation phase is an honest **no-op**,
  precedented by 27.2's "files with no real collapse candidate are not touched and
  get no part" applied to the whole tier. The final gate `npm run test:e2e` (+
  `npm run validate`) confirms the tier is green and unchanged.
- **Under Reading A: exactly one part.** One atomic commit
  `test(e2e): drop bespoke flows the browser parity run already covers` that (i)
  deletes `opfs-roundtrip.spec.ts` entirely (its sole test T1), and (ii) removes
  the `branch` and `notes` `test.describe` blocks (T8, T11) from
  `surface-parity.spec.ts`, keeping log/checkout/tag/ssh. Nothing collapses; no
  `for…of` is introduced. Part gate:
  `npx playwright test surface-parity.spec && npm run check:types && biome check <touched>`
  where the toolchain is available, backed by construction-proof + §3.5
  hand-verify + the CI `e2e` job. Boundary/final: `npm run test:e2e` +
  `npm run validate`.

The tier-ratio pyramid budget is file-count based and warn-only. Under Reading A,
deleting `opfs-roundtrip.spec.ts` removes one E2E file — confirm the warn-only
budget still tolerates the count (it removes no *distinct capability*, since the
journey survives in parity). Under Reading B no file changes. **Never commit on a
red gate.**

## 6. Decision candidates (for the ADR conversation → ADR-500)

### Decision 1 — does the browser parity run "cover" a bespoke journey? (pivotal, load-bearing)

The 34 `SCENARIOS` run on the browser adapter by `parity.spec.ts` include journeys
three bespoke flows also assert (T1↔`init-add-commit-status`, T8↔`branch-lifecycle`,
T11↔`notes`). "Parity cross-products excluded from the overlap audit" cuts two ways:

- **(A) Aggressive — parity covers the journey; delete the redundant flows.** The
  browser parity run already asserts init→add→commit→status / branch / notes on
  the browser adapter, so T1/T8/T11 are *redundant journeys* (treating their
  differing seed content/message/note as non-distinguishing, §1.1) → delete
  `opfs-roundtrip.spec.ts` and the branch/notes blocks of
  `surface-parity.spec.ts`. / cons: they are **not literal strict subsets** (each
  seeds a different input), so this requires *loosening* "distinguishing input"
  beyond what 27.1/27.2 did; contradicts the backlog clause and ADR-499's
  precedent that parity is "NOT overlap … stay distinct" and "never counted as a
  retained test"; strands the bespoke browser-engine smoke path (per-`test.step`
  localisation, input-independence) behind a golden-locked cross-adapter test
  owned by a different concern.
- **(B) Conservative — parity is a different axis, excluded from the audit; keep
  all bespoke flows.** *(recommended.)* The audit compares bespoke flows against
  **each other only**; the parity driver is never a comparand and covers nothing.
  Consequence: the bespoke set has zero cross-overlap → the E2E tier is already
  minimal → 27.3 is a confirming audit that deletes no tests. / Directly honours
  the backlog's own definition ("Parity cross-products … are NOT overlap") and
  ADR-499's non-negotiable ("never … counted as a retained test that could make a
  test a strict subset"); preserves the tier's independent browser-engine
  guarantee. / cons: 27.3 lands as a (near-)empty implementation PR — legitimate
  but unusual for a minimisation item.
- **(C) Strict application only — delete a bespoke flow only when it is a *literal*
  strict subset of a parity scenario (same inputs, contained assertions).** Because
  every bespoke flow seeds `'hello browser\n'` while its parity counterpart seeds
  `'hello a\n'` (§1.1), **no** flow is a literal subset → (C) deletes nothing. So
  the *strict* ADR-498 methodology, applied without loosening "distinguishing
  input", already yields Reading B's outcome — only the *looser* Reading A (seed
  content is non-distinguishing) deletes anything. / cons: reaches B's result by a
  narrower argument; offered only to show the strict methodology and B agree.

**Recommendation: (B).** The backlog wording carried verbatim from 27.2, and
ADR-499's restated non-negotiable, both classify cross-adapter parity as a
distinct axis that is *never* a retained comparand. Extending that precedent, the
E2E cross-adapter **driver** (`parity.spec.ts`) is the carve-out; the bespoke
flows each assert a distinct journey/capability no *other bespoke* flow asserts,
so the tier is already at one-flow-per-journey. The user decides.

### Decision 2 — the E2E-tier backstop model

Coverage/mutation/pyramid are all zero-signal for E2E (§4):

- **(A) Construction-proof + browser-engine-preservation review + green
  `test:e2e` (CI authority) + parity-goldens-unchanged + targeted hand-verify**
  (§3). *(recommended.)* Journey preservation is a theorem; the reviewer verifies
  per-flow engine coverage + union-of-inputs by reading the diff; the suite proves
  surviving flows pass; goldens are provably untouched. / cons: leans on reviewer
  discipline, not a headline number — even more than 27.2, since no cross-tool
  byte-compare exists either.
- **(B) Add the browser adapter / E2E to a coverage run so a number backstops it.**
  / cons: out of scope — a `vitest.config.ts` / Playwright-config / CI edit this
  PR forbids; Playwright coverage of a real engine is noisy and slow.
- **(C) Gate on a new E2E pyramid heuristic.** / cons: no such heuristic exists;
  authoring one is a budget/tooling change this PR excludes, and it would check
  shape, not overlap.

### Decision 3 — secondary shape choices (adopt-as-recommended unless the user diverges)

- **3a. May `hash-interop` (a) + (b) merge into one parameterised flow?**
  **(A) No — keep separate** *(recommended)*: different acts (raw
  `BrowserHashService` vs facade `writeObject`/`readBlob`), different oracles
  (hex-equality vs byte round-trip), different engine-gating ((a) runs webkit,
  (b) is OPFS-skipped). Merging would force (b)'s webkit-skip onto (a), zeroing the
  only webkit SHA-1 probe. / (B) merge under one `describe` — cons: violates §3.2
  (loses a `(journey, engine)` pair) and the same-act rule.
- **3b. If a flow is kept, keep its `test.step` granularity?** **(A) Yes — keep it
  verbatim** *(recommended)*: `test.step` is a flow's error-localisation contract,
  not overlap; minimisation never flattens a kept flow's steps. / (B) flatten to
  one assertion block — cons: degrades failure diagnostics for no coverage gain.
- **3c. Does ADR-500 refine ADR-498/499, or stand alone?** **(A) Refine —
  record only the E2E-tier deltas** *(recommended)*: ADR-498 names 27.3 an
  inheritor; ADR-500 inherits KEEP/COLLAPSE/DELETE + guard-rails + construction
  proof and records only the deltas (engine axis; `for…of` idiom; parity-driver
  carve-out by mechanism; all-signals-dark backstop). / (B) restate standalone —
  cons: duplicates ADR-498/499, they drift. / (C) extend ADR-499 in place — cons:
  muddies a ratified run-specific ADR.

### Decision 4 — whole tier in one PR?

- **(A) Yes — all 4 bespoke spec files audited in one PR** *(recommended)*, matching
  27.1/27.2's whole-tier scope. The tier is tiny (12 cases), so a single PR is
  reviewable. / (B) file-by-file PRs — cons: process overhead dominates a
  12-case tier. / (C) defer OPFS-gated flows the darwin host can't fully run —
  cons: CI `e2e` covers them; no reason to strand.

## 7. Non-goals

- **No `src/` production change** (not even a comment) — tests-only.
- **No new tests, no new assertions** — minimisation only keeps/collapses/deletes
  existing flows. A genuine journey or engine-coverage *gap* found mid-work is
  surfaced, not papered over with a new flow smuggled into a minimisation commit.
- **No touching `parity.spec.ts`, `parity-scenarios.bundle.ts`, `test/parity/**`,
  or `test/runtime-parity/**`** (cross-adapter carve-out, §4), and **no parity
  golden edits**.
- **No touching the `readyPage` / `seedRepo` fixtures, the
  `test.skip(webkit)` engine guards, `serve.mjs`, or `index.html`.**
- **No `sut`-retrofit or GWT/AAA re-styling** of kept flows — preserve each file's
  existing Playwright convention; the bar is "no worse than today".
- **No threshold, budget, or config edits** (`test-pyramid-budgets.json`,
  `mutation-budgets.json`, `playwright.config.ts`, `vitest.config.ts`) — this PR
  raises no floor and moves no gate.
- **No new browser behaviour pinned** — every bespoke flow already encodes an
  observed browser-adapter behaviour; `.claude/workflow/faithfulness.md`
  empirical pinning does not apply.
