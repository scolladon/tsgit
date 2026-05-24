# ADR-109: Test-pyramid audit gating posture (per-heuristic, default-off)

## Status

Accepted (at `36975ef`)

## Context

19.2 shipped the test-pyramid audit as report-only (ADR-104). The design
explicitly handed forward the gate-conversion conversation to 19.3
(under-assertion) and 19.4 (over-mocked-integration). 19.3 needs a
mechanism to:

1. Promote `underAssertedUnit` (from 19.2) to a CI-blocking gate.
2. Gate the four new expressiveness heuristics (GWT title, AAA body,
   `sut` naming, bare-class `toThrow`).
3. Leave `overMockedIntegration` report-only until 19.4 promotes it.

Three approaches were considered:

- **All-or-nothing flag** — a single `gating: true|false` switch flips
  every heuristic at once. Simple but couples unrelated decisions; a
  future heuristic shipping as report-only would force the entire audit
  back to non-gating.
- **Per-heuristic boolean map** — a `gating` object inside the manifest
  with one key per heuristic name; missing keys default to `false`. New
  heuristics can land report-only and graduate to gating by flipping a
  single bit. Schema validation rejects unknown heuristic names so typos
  don't silently disable a gate.
- **Implicit gating from heuristic shape** — every heuristic gates;
  report-only is the absence of a heuristic. Forces deletion-then-restore
  to demote a finding for an emergency. Loses configurability.

## Decision

Adopt the **per-heuristic boolean map** (option two). The manifest gains a
top-level `gating` object:

```json
"gating": {
  "underAssertedUnit":      true,
  "gwtTitle":               true,
  "aaaBody":                true,
  "sutNaming":              true,
  "bareClassToThrow":       true,
  "overMockedIntegration":  false
}
```

`audit-test-pyramid.ts` computes the exit code by intersecting the gating
map with the populated finding arrays — any gated heuristic with ≥ 1
finding flips the exit to `1`. Missing keys default to `false`
(report-only) so adding a new heuristic doesn't silently gate. The schema
rejects unknown heuristic names.

A CLI flag `--report-only` overrides the entire gating map at runtime
(returns exit `0` regardless of findings) — useful for local exploratory
runs and during the cleanup sequence within the 19.3 PR.

## Consequences

### Positive

- **Independent promotion path** — each heuristic graduates from
  report-only to gating with a one-line manifest change and a corresponding
  ADR.
- **Default-off keeps surprises in check** — a typo in the gating key
  silently leaves the heuristic report-only rather than silently gating
  on stale data.
- **Backwards compatible with 19.2** — the same manifest works without a
  `gating` key (everything report-only).
- **`--report-only` flag preserves the original ergonomics** for ad-hoc
  invocations and matches the design-doc cleanup sequence.

### Negative

- **Manifest grows a third top-level key.** Mitigated: documented in the
  manifest schema and design doc; the same hand-rolled checker pattern as
  19.2 §6.2 covers validation.
- **Per-heuristic graduations require ADRs.** Considered a feature, not a
  cost: every CI gate change carries its own rationale.

### Neutral

- The 19.2 reports stay readable on PR artifacts even when gating is on;
  the markdown/JSON content is unchanged, only exit code differs.
