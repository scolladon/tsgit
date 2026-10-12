---
subjects:
  - src/application/primitives/resolve-oid-prefix.ts
  - src/application/primitives/internal/ambiguous-candidates.ts
---
# 941 — An ambiguous abbreviated id lists every candidate, as git does

- **Status:** accepted
- **Date:** 2026-10-04
- **Design:** docs/design/alternates-object-lookup.md · **Supersedes/Refines:** supersedes ADR-222's candidate cap; refines ADR-226

## Context

ADR-222 capped the `AMBIGUOUS_OID_PREFIX` candidate list at 16 so that a hostile repository full of
near-collisions could not inflate the thrown error. git 2.55's `get_short_oid` lists every
candidate after `hint: The candidates are:`, ordered tags, commits, trees, blobs (each by id), and
describes each one: a commit with its short author date and folded subject, a tag with its tagger date
and name, a tree or blob with its type. A 4-hex prefix is 16 bits, so a crafted repository can make the
list arbitrarily long; git pays that cost too.

## Options considered

1. **List every candidate, as git does.**
2. **Keep the 16-candidate cap**, recording the truncation as a divergence.

## Decision

**User-ratified — option 1.** The error data and the logged hint payload carry every candidate in
git's order, each described as git describes it. ADR-222's cap is removed.

## Consequences

- A hostile repository can grow the error and the log payload as large as git's stderr would be;
  the security review signs off on this as git's own exposure.
- Logged candidate subjects are attacker-controlled text and go through the logger sanitiser like any
  other logged string, nested payload fields included.
- Interop rows pin a list longer than 16 against git.
