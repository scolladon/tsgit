# Plan — E2E test minimisation (27.3)

> Source: design doc `docs/design/e2e-test-minimisation.md` (57edd3ec) · ADRs `500` (b30ac5ff)
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- The ratified reading is **Reading B** (design Decision 1, ADR-500 §Decision 1). Under
  Reading B the complete 12-case audit (design §1.1) finds **zero cross-bespoke overlap**:
  every bespoke flow asserts a distinct `(journey, engine)` no other bespoke flow asserts,
  and the cross-adapter parity driver is never a comparand. The E2E tier is therefore
  **already minimal** — 27.3 is a **confirming audit that deletes and collapses no tests**.
- Consequence: **no `src/` change and no test change.** `test/browser/**` and `test/parity/**`
  stay byte-identical. There is nothing to collapse, nothing to delete, no `for…of` to
  introduce, no fixture/guard to touch (design §5 Reading B; ADR-500 §Decision, "Outcome").
- `plan-lint.sh` requires ≥1 `## Part`, so the plan is a **single verification-only part** —
  the one executable unit the implementation phase owns here: empirically confirm the tier is
  minimal, green, and byte-unchanged. This is not a test-only-part smell (there is no feature
  code to fold into); it is the honest shape of a no-op audit, precedented by 27.2's "files
  with no real collapse candidate are not touched", applied to the whole tier.
- **This part proves the no-op; it does not perform one.** The implementation phase lands
  **nothing** (see `### Commit`). The design (57edd3ec) + ADR-500 (b30ac5ff) are already
  committed; the backlog tick + reference links are the DOCUMENTATION phase's job, not this
  part's.

## Part 1 — Confirming-audit verification (no source or test change)

### Context

**What this part does:** prove — by observation, not edit — that the E2E tier is already at
one Playwright flow per distinct journey/capability, is green end-to-end, and is
byte-identical to `HEAD`. **Nothing is edited.** Any diff produced by this part is a defect.

**The E2E surface (from `playwright.config.ts`: `testDir ./test/browser`, `testMatch
*.spec.ts`, projects `chromium` / `firefox` / `webkit`).** The audit set is **12 bespoke
`test()` cases across 4 spec files** under `test/browser/`; each is a distinct
journey/capability, named per the design's audit table (design §1.1, T1–T12):

- `test/browser/opfs-roundtrip.spec.ts` — **1** case:
  - **T1** `init→add→commit→status` porcelain write path, asserted per `test.step`
    (init main/non-bare · add stages `a.txt` · commit 40-hex on `refs/heads/main` · status
    clean+attached). Engines: chromium, firefox (`test.skip(browserName === 'webkit', 'OPFS
    not exposed …')` at file top). Sole *bespoke* asserter of this journey.
- `test/browser/hash-interop.spec.ts` — **2** cases:
  - **T2** SubtleCrypto SHA-1 of `blob <n>\0hello\n` == git golden `ce0136…` via
    `BrowserHashService.hashHex`; pure capability, no repo/OPFS. Engines: **chromium, firefox,
    webkit** (the only webkit-running SHA-1 probe).
  - **T3** `writeObject`→`readBlob` byte-exact content round-trip through the facade. Engines:
    chromium, firefox (per-test `test.skip(browserName === 'webkit', …)`).
- `test/browser/decompression-stream.spec.ts` — **3** cases, all on **chromium, firefox,
  webkit** (pure capability, no OPFS-skip):
  - **T4** deflate→inflate `BrowserCompressor` round-trip byte-identity.
  - **T5** non-zlib bytes → typed `TsgitError` `data.code === 'DECOMPRESS_FAILED'`.
  - **T6** multi-member `streamInflate` (>64 KiB member + a second) → exact output +
    `bytesConsumed` per member.
- `test/browser/surface-parity.spec.ts` — **6** cases (file-top `test.skip(browserName ===
  'webkit', …)`), 6 different commands with different acts/oracle shapes:
  - **T7** `log` — 2 commits newest-first + parent linkage.
  - **T8** `branch` — create→list→delete lifecycle incl. `current` flag.
  - **T9** `checkout` — divergent branches materialise working file v1/v2.
  - **T10** `tag` — create→list→delete lifecycle.
  - **T11** `notes` — add→list→read→remove lifecycle.
  - **T12** `ssh-clone-refusal` — ssh clone → typed `ADAPTER_UNAVAILABLE`, no network touched.

**The parity carve-out — drawn by MECHANISM, never a comparand, left byte-identical.** The
cross-adapter driver is `test/browser/parity.spec.ts` (a registry-completeness guard `test()`
that asserts `window.__tsgitParity` exposes exactly the `SCENARIOS` names, plus the
`for (const scenario of SCENARIOS)` loop emitting one `test()` per scenario against an
OPFS-backed `Repository`) + its bundle `test/browser/parity-scenarios.bundle.ts`, backed by
the shared goldens under `test/parity/**` (asserted identically by `test/parity/node.test.ts`
and `test/parity/memory.test.ts`). This proves cross-**adapter** equivalence — a *different
axis* from user-journey coverage — so under Reading B it is **never counted as a retained flow
that could make a bespoke flow a subset** and is **not touched**. `surface-parity.spec.ts`,
despite its name, is **not** the driver (it is 6 bespoke journeys, in the audit) — the
boundary is the SCENARIOS-driving mechanism, not the filename (design §"The parity carve-out";
ADR-500 §Context delta 4).

**Distinguishing axes that make the tier already-minimal** (design §1.1, §3.2): the **browser
engine** (chromium / firefox / webkit) is a distinguishing input — WebKit's headless
Playwright build exposes no OPFS (`navigator.storage.getDirectory`), so every OPFS-backed flow
skips webkit; only T2 (SHA-1) and T4/T5/T6 (decompression) run on webkit and are the *sole*
webkit executors of their capability. No two bespoke flows share a `(journey, engine)` pair;
no COLLAPSE candidate exists (the 3 decompression flows have structurally different oracles;
`hash-interop` (a)/(b) have different acts + engine-gating; the 6 surface commands are 6
different SUT namespaces).

**Files that MUST remain byte-unchanged (the whole tier):** the 4 bespoke specs above; the
carve-out (`parity.spec.ts`, `parity-scenarios.bundle.ts`, `test/parity/**`,
`test/runtime-parity/**` — no golden edits); the fixtures/support
(`test/browser/fixtures.ts` `readyPage`/`seedRepo`, `index.html`, `serve.mjs`); every
`test.skip(browserName === 'webkit', …)` engine guard; and all thresholds/config
(`playwright.config.ts`, `vitest.config.ts`, `test-pyramid-budgets.json`,
`mutation-budgets.json`). No `src/` file is touched — not even a comment (design §7 Non-goals).

**Surface gates (from `.claude/workflow/surface-gates.md`):** this PR introduces **no new
exported symbol, no new Tier-1 command, no new error code, no barrel/facade/api.json change**.
It is docs-only with tests unchanged → **no surface gate applies** (no barrel, no
`repository.test` snapshot, no `check:doc-coverage` command page, no `audit-browser-surface`
allowlist, no `reports/api.json` regen). Nothing to pre-pay.

**Why the outcome bar cannot be freshly measured (design §"Why the outcome bar…"; ADR-500
§Context):** every mechanical correctness signal is dark for the E2E tier —
`npm run test:coverage` runs the **unit** vitest project only and never includes
`adapters/browser`; Stryker mutation scopes the diff to `^src/.*\.ts$` (a tests-only/no-op diff
mutates nothing) and mutates `src/` against the **unit** suite only, never loading a Playwright
spec; and every gating heuristic in `test-pyramid-budgets.json` is `tier: unit`, so
`check:test-pyramid` gates nothing on a Playwright `test()`. Coverage / mutation / pyramid are
**all zero-signal** here. The backstop is therefore construction-proof + browser-engine
preservation + a green suite + byte-identical goldens (ADR-500 §Decision 2).

### TDD steps

This is a **verification** part, not RED→GREEN→REFACTOR. Under a no-change confirming audit
there is no failing test to author and no production code to write, so a RED step is
**vacuous** — and provably so: per design §"Why the outcome bar cannot be freshly measured",
coverage, mutation, and the pyramid heuristics are all zero-signal for the E2E tier, so there
is no mechanical number a new test could move and no mutant a new test could kill. Writing a
new flow would also violate design §7 Non-goals ("No new tests, no new assertions"). The
executable obligation is instead to **observe** the three invariants:

1. **Byte-identity (goldens + specs unchanged).** Confirm `git diff --no-ext-diff 5fb0c9c1 --
   test/` is **empty** — no bespoke spec touched (T1–T12 all byte-identical), no parity golden
   moved, no fixture/guard edited. (Also confirm `git status --porcelain -- test/ src/` is
   clean.) Expected: empty output. A non-empty diff means the no-op was violated → stop and
   escalate `{ Part 1, unexpected test/src delta, ≤3 options }`; do not "fix forward".
2. **Green suite across all 3 engines.** Run `npm run test:e2e` (`npx playwright test` — the
   `chromium` / `firefox` / `webkit` projects). Expected: all surviving flows pass, unchanged.
   **CI is the green authority** for engines the local darwin host cannot fully exercise (its
   headless webkit lacks OPFS; browser installs vary) — a partial local run is not claimed as
   proof of a cross-engine result (design §3.3; ADR-500 §Decision 2). If the local host cannot
   run webkit, note that the CI `e2e` job is the authority and proceed.
3. **Whole tier green end-to-end.** Run `npm run validate` (includes `check:test-pyramid`,
   `check:parity-fixtures`, `check:browser-surface`, `test:parity`, `test:coverage`,
   `test:integration`, … — all unaffected by a byte-identical tier). Expected: green.

No REFACTOR step: there is no code delta to clean up. The part's deliverable is the
*observation* that the tier is minimal, green, and byte-unchanged — recorded by the gate below
passing, not by any file edit.

### Gate

```
npm run test:e2e && npm run validate
```

Whole-suite green is the confirming-audit backstop per ADR-500 §Decision 2 = construction-proof
(the 12-case audit finds zero cross-bespoke overlap) + browser-engine preservation (every
`(journey, engine)` pair, incl. the webkit-only T2/T4/T5/T6 probes, still runs) + green suite +
parity goldens byte-unchanged. **Never commit on a red gate** — and here there is nothing to
commit regardless (see `### Commit`).

### Commit

**No commit.** This part is verification-only: under the ratified Reading B there is **no
`src/` change and no test change**, so there is no atomic commit for the implementation phase
to land. The load-bearing deliverables are already committed on this branch — the design doc
(57edd3ec) and ADR-500 (b30ac5ff). The backlog completion (ticking **27.3** in
`docs/BACKLOG.md` + adding the design/ADR reference links) belongs to the **DOCUMENTATION
phase**, not this part. The implementation phase lands **nothing**; it exits once the gate
above is green.

## Decision candidates (for the ADR conversation)

**None — all load-bearing choices are ratified in ADR-500** (b30ac5ff): Decision 1 (Reading B —
parity is a distinct axis, keep all bespoke flows; the tier is already minimal), Decision 2
(the all-signals-dark backstop model), Decision 3a–3c (keep `hash-interop` (a)/(b) separate;
preserve `test.step` granularity; ADR-500 refines ADR-498/499), and Decision 4 (whole tier in
one PR). Nothing in this plan reopens them.
