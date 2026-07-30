# 538 — Discovery walk runs in node + memory; browser resolves its fixed entry pointer-aware

- **Status:** accepted
- **Date:** 2026-07-29
- **Design:** docs/design/linked-worktree-discovery.md · **Supersedes/Refines:** refines ADR-298 (worktreeFs absent in browser)

## Context

R9 wants one discovery implementation, but the browser adapter is rooted at `/` with a
slash-terminated `ROOT_WORK_DIR` and a configurable `gitDirName` — a walk-up from `/`
terminates on its first iteration, so running the full walk there is dead code with a
live cost. The memory adapter today hardcodes its layout and never discovers.

## Options considered

1. **All three shims run the same walk** — pros: uniform / cons: the browser walk is dead code by construction.
2. **Node + memory walk; browser resolves its fixed `/{gitDirName}` entry, applying the same pointer + commondir resolution when that entry is a file** (recommended) — pros: memory gains real discovery so cross-adapter parity can cover the layout; browser reuses the same parsers without a meaningless walk / cons: two entry paths, both thin.
3. **Node only** — pros: minimal / cons: parity coverage of the layout would be node-only.

## Decision

**Adopted-as-recommended (no user judgment).** Option 2: `findLayout` is shared by the
node and memory shims (via `LayoutProbe`); the browser shim resolves its fixed entry and
reuses `parseGitfilePointer`/`parseCommondir` when the entry is a file. A pointer
resolving outside a sandboxed adapter's root surfaces the adapter's own containment
error — the faithful sandbox answer, not a special case.

## Consequences

Memory-adapter worktree layouts (wholly inside `rootDir`) become expressible and
parity-testable; the browser keeps its fixed-root model with pointer support.
