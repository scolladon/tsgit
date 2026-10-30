---
subjects:
  - src/ports/file-system.ts
  - src/adapters/node
  - src/application/primitives/ref-store.ts
---
<!-- cspell:ignore opendir -->
# 1133 — the integrity walk reads directories in the operating system's order

- **Status:** accepted
- **Date:** 2026-10-30
- **Design:** docs/design/fsck-broken-ref-chain-unreadable.md (DC-4) · **Plan:** docs/plan/fsck-broken-ref-chain-unreadable.md · **Supersedes/Refines:** refines ADR-1128

## Context

Node's `fs.readdir` returns entries sorted; git reads directories with `readdir(3)`, in the operating system's
order (probe: `readdirSync` `a b m y z`, `opendir` and `ls -f` `z a m b y`). Under ADR-1128 the content
lines lost after an unresolvable link depend on that order.

## Options considered

1. **An optional public `FileSystem.readdirInOsOrder?`, used only by the integrity walk** (planner's
   recommendation) — pros: git's lost lines reproduce / cons: a port addition.
2. **Keep sorted order under a divergence ADR.**
3. **Report every line** — cons: reverses part of ADR-1128.

## Decision

**Ratified by the user: option 1.** The `FileSystem` port gains an optional `readdirInOsOrder?`; the Node adapter
implements it with `opendir`. Only the refs integrity walk calls it, falling back to `readdir` when absent.

## Consequences

- A public, additive port member.
- Lost-line rows depend on the filesystem; they are pinned against git on the same throwaway.
