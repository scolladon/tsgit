---
subjects:
  - src/ports/file-system.ts
  - src/application/commands/internal/working-tree.ts
  - src/repository/wrap-fs-validator.ts
---
# 1217 — mv renames a directory in one step where the port can

- **Status:** accepted
- **Date:** 2026-11-19
- **Design:** docs/design/mv-directory-one-rename.md (D1) · **Supersedes/Refines:** applies ADR-226, follows ADR-705 and ADR-873

## Context

git `rename(2)`s a moved directory once. tsgit moves it leaf by leaf, so a deep untracked
descendant whose path exceeds the host's `PATH_MAX` strands a half move (rows 1–3), and a
case-only `mv d D` on a case-insensitive host moves every leaf into the source and then deletes
it (row 5). The node and memory adapters already rename a directory source natively; the OPFS
adapter cannot.

## Options considered

1. **A new optional port member `renameDirectory?`** — node and memory delegate to `rename`, the
   browser adapter omits it, `wrapFsValidator` forwards and guards it.
2. Reuse `atomicRename`'s presence as the signal — couples atomic replacement with directory
   support; an adapter may offer `atomicRename` for files only.
3. Require every adapter's `rename` to accept a directory — breaks third-party file-only adapters
   that work today through the leaf loop.

## Decision

Option 1, ratified by the user. An absent member is a documented answer (ADR-705): the caller
falls back to the entry-by-entry move of ADR-1218.

## Consequences

Every `FileSystem` wrapper must forward the member when the inner adapter has it and omit it
otherwise; `wrapFsValidator` is the only one in `src`, and it guards both paths as writes. The
member is additive and optional, so third-party adapters keep compiling.
