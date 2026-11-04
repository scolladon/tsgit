---
subjects:
  - src/application/primitives/resolve-oid-prefix.ts
  - src/application/primitives/abbreviate-object-id.ts
---
# 1144 — the fanout fault policy lives in the shared loose scan

- **Status:** accepted
- **Date:** 2026-11-04
- **Design:** docs/design/rev-parse-corrupt-input.md · **Supersedes/Refines:** refines ADR-222

## Context

`scanLooseIn` serves both `resolveOidPrefix` and `abbreviateObjectId`'s rival search. With a packed
clone and one fanout directory of mode 000, git `rev-parse --short HEAD` and `describe --always` exit
0 with one `unable to open` line, while tsgit's `abbreviateObjectId` throws `PERMISSION_DENIED`
(pinned twice on 2.56.0).

## Options considered

1. **The skip-and-log policy of ADR-1142 inside `scanLooseIn`**, so both callers get it — pros: same
   function, same fault, one classifier / cons: none found. The designer's recommendation.
2. **Only around `resolveOidPrefix`'s call** — cons: abbreviation keeps throwing where git prints.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** The classifier of ADR-1142 lives in
`scanLooseIn`; every caller of the loose scan, abbreviation included, skips a fanout
directory that cannot be listed and logs it once per scan, memoised per session (ADR-1143).

## Consequences

- The twenty-one `abbreviateObjectId` callers gain the skip; a `log` over many commits logs the
  directory once, as one git process does.
