# 524 — Byte-identical change lists proven by a permanent differential property test

- **Status:** accepted
- **Date:** 2026-07-28
- **Design:** docs/design/raw-tree-cursor-diff.md · **Refines:** ADR-134–136 (property-test policy)

## Context

Acceptance requires the raw walk's change lists to be identical to the parsed implementation's. A one-shot or fixture-only proof expires with the next change.

## Options considered

1. **Permanent differential property test (recommended)** — `diffRawTrees(serializeTreeContent(a), serializeTreeContent(b)) ≡ diffTrees(a, b)` over arbitrary name-deduplicated trees, plus `compareCursorNames ≡ treeEntryCompare`. Oracles are existing, independently-tested production code — not a tautology.
2. **Throwaway scaffold over the bench fixtures** — proves it once, for those fixtures only.
3. **Manual one-shot recorded in the PR body** — weakest; guards nothing.

## Decision

**Ratified by user — Option 1.** The differential properties ship as permanent `*.properties.test.ts` siblings; `serializeTreeContent` canonicalises order so both sides are comparable by construction.

## Consequences

Any future divergence between the raw and parsed walks fails CI immediately. The property files follow the ADR-134 layout and tiered `numRuns`.
