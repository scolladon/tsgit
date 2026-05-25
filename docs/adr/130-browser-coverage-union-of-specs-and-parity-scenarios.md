# ADR-130: Browser coverage is the union of dedicated specs and parity scenarios

## Status

Accepted (at `75a0cde6`)

## Context

The 19.5a audit must answer: "is this `Repository` member exercised
in the browser?" Two test sources can prove that:

- A spec under `test/browser/*.spec.ts` calls `repo.<name>(...)` from
  inside a `page.evaluate` against the OPFS-backed `Repository`.
- A scenario under `test/parity/scenarios/*.ts` that the existing
  `test/browser/parity.spec.ts` runs by-name (ADR-127) against
  OPFS — also via `page.evaluate` against the same `Repository`.

Both reach the browser-bound facade. Both surface the same failure
mode if the call breaks. The audit must decide whether to treat them
as equally valid coverage, or to prefer one over the other.

## Decision

Browser coverage is the **union** of:

1. Call sites matching `\brepo\.<name>\s*\(` in any file under
   `test/browser/*.spec.ts`.
2. Call sites matching the same pattern in any file under
   `test/parity/scenarios/*.ts`.

A surface is "covered" if its name appears in either set. The report
lists every matching file under `sources[]` for traceability, but the
gap check makes no preference between the two.

This treats the parity harness as the cheap path for closing gaps:
one scenario file added under `test/parity/scenarios/` lights up Node
+ Memory + Browser coverage in one move. Dedicated browser specs
remain for OPFS-specific concerns (e.g., `opfs-roundtrip.spec.ts`
asserts step-by-step OPFS persistence; `surface-parity.spec.ts`
checks behaviour across `page.evaluate` boundaries that a parity
scenario's golden cannot express).

## Consequences

### Positive

- New scenarios become the canonical way to close gaps — one file,
  three drivers covered.
- The audit doesn't penalize authors for picking the lower-friction
  path. The two test sources stay complementary rather than
  competing for the same surface.

### Negative

- A scenario that exists only on paper (no `run` body that exercises
  the named call) would falsely advertise coverage. The regex
  matches mention, not invocation. Mitigated by the existing
  parity-fixtures audit (`tooling/audit-parity-fixtures.ts`) and the
  golden-`commit.id` assertion — both flag dead scenarios sooner
  than the surface audit would.
- Cross-file noise: a comment in a spec mentioning `repo.foo(` would
  count as coverage. Acceptable in practice — comments referencing a
  hypothetical call site are rare, and a stricter parser
  (AST-based) buys precision the audit doesn't need.

### Neutral

- The audit doesn't track which adapter (Node, Memory, Browser)
  proved coverage. The parity harness assertion that all three
  agree is enforced by the existing `parity` test job; the surface
  audit only asks "does the browser reach this name?".
