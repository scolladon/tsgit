---
subjects:
  - src/application/primitives/ref-store.ts
  - src/application/primitives/resolve-ref.ts
---
# 1131 — resolution through an unreadable directory keeps the permission refusal

- **Status:** accepted
- **Date:** 2026-10-30
- **Design:** docs/design/fsck-broken-ref-chain-unreadable.md (DC-1) · **Plan:** docs/plan/fsck-broken-ref-chain-unreadable.md · **Supersedes/Refines:** refines ADR-1126

## Context

A packed `refs/heads/d/x` with a loose `refs/heads/d/` at mode 000 or 0400: git 2.56.0 `rev-parse` exits 128
`unknown revision`, and `rev-list --all` and `gc` at 0400 die `fatal: bad object refs/heads/d/x` (128). tsgit
refuses `PERMISSION_DENIED` and never returns the packed value. Reading the name as missing, as the design's
first wording said, would turn git's two deaths into silent successes.

## Options considered

1. **Read as missing** — cons: needs two extra caller rules to restore git's deaths.
2. **Keep the `PERMISSION_DENIED` refusal** (planner's recommendation) — pros: every pinned row's refuse or
   succeed outcome already matches git; fsck maps it to the zero pointer (ADR-1123).
3. **A broken-class refusal code** — cons: widens every `resolveRefOrMissing` caller on unpinned shapes.

## Decision

**Ratified by the user: option 2.** A loose path whose leading directory is unsearchable keeps refusing
`PERMISSION_DENIED`, never falling back to the packed value. The resolution rows are pinned as guards.

## Consequences

- ADR-1126's second folded finding is corrected to this rule.
