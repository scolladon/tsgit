# 505 — Hot-path gate scoping: hot-paths.json registry, all CI-run tiers gated

- **Status:** accepted (mechanism adopted-as-recommended; the gated-tier choice is user
  judgment — the user chose to gate all CI-run tiers over the design's medium-only
  recommendation)
- **Date:** 2026-07-24
- **Design:** docs/design/bench-hot-path-rework.md · **Refines:**
  [ADR-490](490-gate-scope-tsgit-benches-only.md) (the `> tsgit` scope this narrows),
  [ADR-491](491-comparison-logic-extracted-pure-function.md) (pure `compareToBaseline`),
  [ADR-488](488-regression-gate-advisory-non-blocking.md) (advisory posture) · **Relates:**
  [ADR-501](501-hot-path-picking-methodology.md), [ADR-502](502-hot-path-granularity-per-command-operation.md)

## Context

The regression gate (`tooling/bench-check.ts`) today scopes to `tsgit`-named entries
(ADR-490). 27.4 requires it to gate **only hot-path benches**. The hot list lives in a
committed registry (ADR-501, keyed per-operation, ADR-502). Two choices: the scoping
*mechanism*, and *which size tier* the gate compares (the PR job builds small + medium; large
is env-gated off).

## Options considered

**Mechanism:**

1. **`docs/perf/hot-paths.json` registry read by the gate + a consistency check** (design
   recommendation) — the gate filters entries to operations in `hotOperations`; a test asserts
   the registry ⟷ the tiered benches agree. / pros: single source shared with fixture tiering
   (no drift); ADR-ratified with a defined refresh cadence. / cons: none material.
2. Key-naming marker token in describe titles. / cons: couples human titles to gate logic.
3. `test/bench/hot/` directory convention. / cons: a large file move that hides the tier in
   the path, not the data.

**Gated tier:**

- **Medium only** (design recommendation) — small is ~50-commit sub-ms, inside the noise
  floor; but medium-only needs a prose-title substring match on the tier phrase (a mild
  tooling-side ADR-249-adjacent smell).
- **All CI-run tiers (small + medium)** (user choice) — no tier filter needed; small's
  sub-ms jitter can flag ~10% on noise, absorbed by the advisory posture (ADR-488).

## Decision

**Mechanism:** the gate reads a committed **`docs/perf/hot-paths.json`** registry and keeps
an entry only if its operation is in `hotOperations`. `gatedEntries` gains a second filter
after the `> tsgit` filter:

```
hotGatedEntries(entries, hot) =
  entries
    .filter(e => e.name.endsWith(' > tsgit'))        // ADR-490 (unchanged)
    .filter(e => hot.includes(operationOf(e.name)))  // NEW — hot-path scope, registry-driven
```

`operationOf(key)` is a pure helper (bench-file basename without `.bench.ts`).
`compareToBaseline` is unchanged; only the pre-filter narrows.

**Gated tier:** the gate compares **all CI-run tiers (small + medium)** of hot operations —
**no tier filter**. This deliberately drops the design's medium-only recommendation and, with
it, the prose-title substring match: the gate keys on the registry alone. Small's noise is
absorbed by the gate's advisory/non-blocking posture (ADR-488). Large stays env-gated off in
the PR job, so it is not gated there regardless.

**Rebutting ADR-490's rejected allow-list.** ADR-490 refused a hand-maintained allow-list on
the **iso-git axis** (which external competitors to include — open-ended, third-party,
uncontrolled). A hot-path registry is a **different axis and smell**: it lists **our own**
operations, is the ratified output of a defined methodology (ADR-501) with a per-major-version
refresh cadence, is closed and small (~6 entries), and is drift-guarded by a consistency
check. It is a *decision artifact*, not the maintenance liability ADR-490 rejected.

## Consequences

- The gate's verdict set narrows from all `tsgit` scenarios to hot-operation scenarios across
  every tier the CI run measures.
- Non-tiered / non-hot scenarios (dirty-`status`, the loose-read micro-scenario,
  `delta-chain-read`, the non-hot read/write benches) fall outside the gate by not being in
  the registry — a clean consequence, no special case.
- **No prose-title tier parsing** is introduced — the all-tiers choice keeps the gate keyed on
  structured data (the registry) rather than human titles.
- A missing/unreadable/malformed registry is a **hard error** (no swallow, non-zero exit,
  surfaced loudly under `continue-on-error`), never a silent gate-everything/gate-nothing.
- A consistency check fails **at test time** on registry↔bench drift, before CI runs the gate.
