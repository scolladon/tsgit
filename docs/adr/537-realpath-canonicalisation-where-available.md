# 537 — Resolved layout paths: realpath where available, lexical elsewhere

- **Status:** accepted
- **Date:** 2026-07-29
- **Design:** docs/design/linked-worktree-discovery.md · **Supersedes/Refines:** refines ADR-495 (cross-platform path model)

## Context

git passes the common dir through `real_path`. `NodeFileSystem` confines by realpath and
`index.node.ts` already realpaths `cwd`; leaving the resolved `gitDir`/`commonDir`
lexical would compute `commonAncestor` on unresolved paths while the adapter compares
resolved ones — a spurious `PERMISSION_DENIED` on any symlinked repo (the macOS
`/var` → `/private/var` case). Sandboxed adapters (memory, browser) have no realpath.

## Options considered

1. **Realpath on adapters that expose it (node); lexical `resolve` elsewhere** (recommended) — pros: matches git on the platform where symlinks exist; workable everywhere / cons: per-adapter difference, documented.
2. **Always lexical** — pros: uniform / cons: breaks symlinked repos on node.
3. **Always realpath** — pros: uniform / cons: impossible on memory/browser.

## Decision

**Adopted-as-recommended (no user judgment).** Option 1: the node shim realpaths the
resolved `gitDir` and `commonDir` (as it already does `cwd`); memory and browser stay
lexical. All resolved paths are normalised (no `.`/`..`/empty segments) before reaching
any FS call, since `wrapFsValidator` rejects `..` segments outright. The `.git` probe
uses `stat` (not `lstat`) so a symlinked `.git` behaves as a directory, matching git.

## Consequences

Symlinked main repos and worktrees discover correctly on node; sandboxed adapters keep
their lexical model. Cross-volume Windows worktrees remain the documented ADR-495
fail-closed limitation.
