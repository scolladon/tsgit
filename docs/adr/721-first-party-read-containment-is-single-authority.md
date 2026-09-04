---
subjects:
  - src/repository/wrap-fs-validator.ts
  - src/repository/compose-adapters.ts
  - src/adapters/node/node-file-system.ts
supersedes:
  - adr: "541"
    scope: "the facade wrapper's read-path role for first-party adapters"
---
# 721 — First-party read containment is single-authority

- **Status:** accepted
- **Date:** 2026-08-26
- **Design:** docs/design/perf-remediation-2026-08.md (DC-9) · **Supersedes/Refines:** supersedes ADR-541 (read-path wrapper role only); refines 625-git-parity-containment-posture.md

## Context

Every fs call passes both `wrapFsValidator` and the adapter's own containment. Since the
git-parity containment posture landed (625-git-parity-containment-posture.md), the
adapter read path is lexical and syscall-free — the two layers now perform the same
class of check on the same root set on every read, and the wrapper's `guard` is the top
CPU frame of the merge profile. On writes the layers genuinely differ (the wrapper cannot
do the realpath post-check). `docs/understand/security.md` already documents the
*adapter's* refusal code as the behaviour.

## Options considered

1. **Skip the wrapper for reads on branded first-party adapters; keep it on writes** (recommended, chosen) — pros: removes exactly the duplicate layer; write-side realpath check untouched; observable flip confined to lexical read escapes / cons: needs a provenance brand.
2. **Skip the wrapper entirely for branded adapters** — cons: changes read and write refusal surfaces at once on a security-adjacent boundary.
3. **Keep both layers** — cons: leaves the duplicate check on every read.

## Decision

**User-ratified.** `composeAdapters` brands the first-party adapters it composes; for a
branded adapter the facade wrapper is skipped on **reads** only. User-supplied `opts.fs`
keeps both layers exactly as today. Observable changes, confined to branded read escapes:
the refusal code becomes the adapter's `PERMISSION_DENIED` (which the security doc
already documents), and an in-repo `a/../b` read path is collapsed and accepted rather
than refused. The config-scope `allowSet` sequencing is preserved: scope reads keep
resolving to an empty scope, never a throw.

Superseded from ADR-541: the premise that the facade wrapper is a load-bearing read-path
layer for first-party adapters.
Carried forward from ADR-541: everything else — the adapter's root-set containment model,
canonical-prefix derivation for not-yet-existing roots, and the write-path posture, all
unchanged.

## Consequences

A verdict-identity property test over the containment predicate becomes the gate (path
containment is a tsgit security property, not a git behaviour). The three Stryker
equivalence proofs inside `wrap-fs-validator.ts` are re-proved against the new predicate
structure. `worktreeFs` is memoised by root set as a rider.

**Amendment (2026-08-28):** the "branded adapter's own containment equals the layout's
root set" premise held for `NodeFileSystem` (constructed at exactly
`layoutRootsOf(layout)` by the node shim) but not for `MemoryFileSystem`, which
`index.default.ts` always constructs at a FIXED root (`DEFAULT_WORK_DIR`) independent of
the layout it is paired with — a bare layout whose `gitDir` sits outside that fixed root
widened the branded read surface past the layout, a real containment escape. `composeAdapters`
now brands only `runtime: 'node'`; `runtime: 'memory'` (and `'browser'`, unverified either
way in this pass) stay on the wrapper's own read guard until their adapters are given the
same layout-rooted, multi-root construction `NodeFileSystem` already has. Any future adapter
seeking this brand must be constructed at exactly `layoutRootsOf(layout)`, matching node's
shape, not a fixed or caller-independent root.
