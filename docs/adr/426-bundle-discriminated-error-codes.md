# 426 — bundle adds a discriminated error-code set

- **Status:** accepted
- **Date:** 2026-06-27
- **Design:** docs/design/bundle.md · **Relates:** ADR-249 (structured output), ADR-423 (v2-only), ADR-425 (verify query), ADR-428 (path read ops)
- **Decision class:** D-ERROR adopted-as-recommended (no user judgment)

## Context

Bundle operations have three distinct refusal conditions that git itself distinguishes: an
*empty* bundle (git refuses `create` when the rev-list selects nothing — and distinguishes
"no refs to write" from "no objects/everything excluded"), a *malformed header* (bad
magic / truncated header on read), and an *unsupported version* (a v3 bundle, ADR-423). A
single coarse code would force tests to assert on message text and would not let the
structured error carry the discriminating datum.

## Options considered

1. **A discriminated set** — `BUNDLE_EMPTY { reason }`, `BUNDLE_BAD_HEADER`,
   `BUNDLE_UNSUPPORTED_VERSION` *(designer recommendation)* — pros: each refusal carries
   structured data; the two empty-refusal causes are isolated by `reason`; mutation tests
   assert on `.data.code`/`.data.reason` rather than strings; cons: three union members and
   their exhaustiveness wiring.
2. **A single `BUNDLE_EMPTY` with no reason and message-only header/version errors** —
   pros: fewer members; cons: loses the structured discriminator; forces string-coupled
   tests; weak against StringLiteral mutants.

## Decision

**Option 1 — adopted as the design recommended.** A discriminated set joins the domain
error union: `BUNDLE_EMPTY { reason }`, `BUNDLE_BAD_HEADER`, `BUNDLE_UNSUPPORTED_VERSION`,
and — following the path-based read decision of ADR-428, which postdated this set —
`BUNDLE_READ_FAILED { path }` for the library-owned open/read refusal (git's
`could not open '<path>'`, discriminated from the malformed-bundle case). Each is wired
into the union's exhaustiveness switches and, where barrel-exported, the exhaustive
barrel-surface test.

## Consequences

- Refusal tests assert on the structured `.data` (code + `reason`), per the project's
  mutation-resistant error-assertion convention.
- Adding the codes trips the error-union surface gate (exhaustiveness switches + barrel
  surface test) — pre-paid in the slice that introduces them.
