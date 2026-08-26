---
subjects:
  - src/application/primitives/internal/resolve-tree-path.ts
  - src/domain/objects/tree-cursor.ts
---
# 723 — Cursor descent keeps the duplicate-name refusal

- **Status:** accepted
- **Date:** 2026-08-26
- **Design:** docs/design/perf-remediation-2026-08.md (DC-11) · **Supersedes/Refines:** none

## Context

Rewriting the blame/path-descent onto the raw `TreeCursor` (no decode, no hex) would
silently drop `parseTreeContent`'s duplicate-entry-name refusal, today observable from
`blame`, `read-file-at` and `rev-parse <tree-ish>:<path>`. Whether git itself refuses
duplicate names outside `fsck`/`mktree` is unpinned — no probe was run.

## Options considered

1. **Re-implement the duplicate check in the cursor descent** (recommended, chosen) — pros: behaviour byte-identical; the saving comes from not decoding/hexing, not from dropping the check.
2. **Accept the divergence with an ADR** — cons: rests on an unpinned belief about git; the prime directive forbids silently dropping an observable refusal.
3. **Cursor for intermediate levels only** — cons: keeps the check where trees are narrowest and drops it where they are widest.

## Decision

**Adopted-as-recommended (no user judgment).** The cursor-based descent carries a
per-directory duplicate-name `Set` (names on the descended path only), preserving the
refusal and its error data byte-identically. Mode validation stays eager per visited
entry on the descended directory. If a future probe pins git's actual duplicate-name
behaviour on read surfaces, option 2 may be revisited with that pin.

## Consequences

The descent's win is allocation/decoding elimination only; refusal parity needs no
interop re-pin. A property test over the tree grammar (`resolve-tree-path`) accompanies
the rewrite.
