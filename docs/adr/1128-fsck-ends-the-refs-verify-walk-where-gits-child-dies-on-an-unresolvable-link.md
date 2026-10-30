---
subjects:
  - src/application/commands/internal/fsck/types.ts
  - src/application/commands/internal/fsck/refs-verify.ts
  - src/application/primitives/ref-store.ts
---
# 1128 — fsck ends the refs-verify walk where git's child dies on an unresolvable link

- **Status:** accepted
- **Date:** 2026-10-30
- **Design:** docs/design/fsck-broken-ref-chain-unreadable.md (D8) · **Supersedes/Refines:** refines ADR-226 and ADR-874

## Context

git 2.56.0's `refs verify` child dies with `fatal: Invalid path '<path>': …` on a symlinked loose ref
whose realpath cannot be computed: a missing middle directory, more than 32 hops, or ADR-874's own
`refs/…` link-text shape. The parent fsck reports the child's failure as bit 8 and carries on, and
every content line the child would have printed after that ref, in readdir order, is lost (root refs
included). Pointer lines come from the parent and stay.

## Options considered

1. **Faithful: one terminal finding `{ type: 'refs-verify-ended'; ref; path; reason: 'FILE_NOT_FOUND' |
   'SYMLINK_LOOP' }`, bit 8; the integrity walk stops there** (designer's recommendation) — pros: the
   same readdir order on the same filesystem reproduces git's lost lines / cons: a caller loses findings
   git loses.
2. **The same finding, the walk continues** — cons: a divergence ADR for a reachable shape.
3. **No finding, exit 0** — cons: a larger divergence.

## Decision

**Ratified by the user: option 1.** When the integrity walk meets a symlinked loose ref whose realpath
fails, it emits one `refs-verify-ended` finding with the ref, the absolute path that failed and the
reason, sets bit 8, and stops: no later content finding is emitted, root refs included. Pointer
findings are unaffected. The finding is gated by `checkReferences`.

## Consequences

- The walk order is load-bearing; tests pin both the lost and the kept lines.
- The parent process never crashes (lesson 017 is not engaged).
