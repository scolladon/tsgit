# 453 — Centralize magic literals into concern-colocated named constants

- **Status:** accepted
- **Date:** 2026-07-05
- **Design:** docs/design/magic-literal-sweep.md · **Relates:** ADR-226 (git-faithfulness)
- **Decision class:** D-structure (adopted-as-recommended, no user judgment)

## Context

The same magic literals — state-marker filenames (`MERGE_HEAD`, `ORIG_HEAD`, …), reflog
message prefixes (`reset: moving to `, `revert: `, …), operation labels
(`'cherry-pick'`, `'revert --continue'`), conflict-marker tokens (`<<<<<<<`), and walk
caps — are re-typed inline across dozens of command files. Each re-typing is an
independent opportunity to drift from git's canonical spelling, and the primitive-obsession
smell was flagged during the Phase 22 history-rewrite work. There is no single source of
truth for any one literal.

## Options considered

1. **Concern-colocated per-concern modules** — one small module per literal family, living
   with its domain concern (the existing `domain/merge/merge-labels.ts` precedent). Exports
   `SCREAMING_SNAKE` constants / frozen `as const` tables with *why*-comments.
2. **One central `constants.ts`** — a single grab-bag module every command imports.
3. **Inline `as const` at each primary consumer** — no shared module; each site freezes its
   own literal.

## Decision

Option **1**. It matches the codebase's "organize by feature/domain, many small files,
high-cohesion/low-coupling" principle and the established `merge-labels.ts` shape, and keeps
the domain-boundary rule intact (domain literals stay in `domain/`; application-only
orchestration labels may live in `application/**/internal/`). Option 2 re-introduces the
junk-drawer smell and couples every command to one file; option 3 leaves no single source of
truth. Both rejected.

**Load-bearing constraint (mutation integrity).** Production code imports the constant;
**tests keep their own hardcoded literal oracles**. Sharing the constant with the test would
let a `StringLiteral` mutant of the constant flip both the production value and the test
expectation simultaneously and survive. This is a deliberate non-DRY seam: the test's literal
is an *independent oracle*, not a duplication to remove.

## Consequences

- One canonical spelling per literal; a future edit is a one-line change, not a grep sweep.
- Byte-for-byte faithfulness is preserved — the constants are pure relocations with identical
  values; the interop goldens (`test/integration/*-interop.test.ts`) and unit assertions are
  the drift guard and must stay green with zero golden edits.
- Every new constant is referenced by ≥1 consumer, so it is covered without any suppression.
- Mutation score is not lowered: a mutated constant still dies on the consumer's independent
  test oracle.
