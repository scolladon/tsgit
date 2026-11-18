---
subjects:
  - src/application/primitives/read-sparse-checkout.ts
  - src/domain/sparse/parse-sparse-checkout.ts
  - src/domain/pathspec/compile-glob.ts
---
# 1214 — Sparse patterns fold ASCII case under core.ignorecase

- **Status:** accepted
- **Date:** 2026-11-18
- **Design:** docs/design/sequencer-sparse-cone-writes.md · **Supersedes/Refines:** applies DOCTRINE(D-2)

## Context

Under `core.ignorecase=true`, git matches cone and non-cone sparse patterns case-insensitively over
ASCII: cone `/b/` keeps `B/f` in the work tree (rows case, casenc, caseco). tsgit's matcher is
case-sensitive, so `checkout` diverges on main (caseco). The sequencer's case row matches today
only because tsgit writes every path; making the sequencer sparse-aware would turn it red.

## Options considered

1. **`loadSparseMatcher` reads `core.ignorecase` and builds a folding matcher for every consumer**,
   with an interop pin per consumer.
2. Fold at the sequencer's load site only; the other consumers stay case-sensitive.
3. Defer.

## Decision

**adopted-as-recommended (no user judgment)** — DOCTRINE(D-2): the change makes the row reachable
and the shared primitive already diverges on main.

## Consequences

`buildSparseMatcher` gains an optional `{ ignoreCase }`; `CompileGlobOptions` gains an optional
`caseFold`, off by default, so pathspec and ignore callers are unchanged. ASCII only, as git's
`sane_ctype` `tolower`. Under `false` the verdict is byte-identical to today.
