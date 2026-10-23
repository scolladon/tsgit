---
subjects:
  - src/domain/working-tree-path.ts
  - src/application/primitives/walk-working-tree.ts
---
# 1051 — The working-tree walk admits a `\`-named entry unless the host uses Windows path syntax

- **Status:** accepted
- **Date:** 2026-10-23
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** refines ADR-1044

## Context

On POSIX git stages, lists and restores a file named `a\b` (design rows W1–W5, W7, W16). tsgit's
`validateWalkedEntryPath` refuses a `\` in an entry name on every host, so `add` hides the file
and `status` throws `PATHSPEC_OUTSIDE_REPO`. ADR-1044 already keyed the pathspec intake's `\`
refusal on `windowsPathSyntax`.

## Options considered

1. **Host-gate the walk's check on `windowsPathSyntax`**, the key ADR-1044 uses — `rejectBackslash`
   runs only under Windows path syntax; the flag is one boolean read per entry. Pros: matches the
   POSIX rows and keeps the Windows stance in one place. Designer's recommendation.
2. **Admit it on every host** — admits a separator-bearing name under Windows path syntax, which
   ADR-1044 refused.
3. **Keep refusing but skip the entry instead of throwing** — `status` stops throwing, but `add`
   still hides the file (W1–W5 stay divergent).

## Decision

**Adopted as recommended (no user judgment) — option 1.** Every `walkWorkingTree` consumer
(`add`, `status`, `stash`, the snapshot enumerator, the repository facade) inherits the change.

## Consequences

- Under Windows path syntax nothing changes: the walk and the intake refuse together.
- The index path validator already admits `\`, so the entry stages, lists and restores as pinned.
