---
subjects:
  - src/application/commands/mv.ts
  - src/application/commands/internal/working-tree.ts
---
# 1220 — mv with skipErrors copies git when a rename fails, data loss included

- **Status:** accepted
- **Date:** 2026-11-19
- **Design:** docs/design/mv-directory-one-rename.md (D4) · **Supersedes/Refines:** applies ADR-226

## Context

`git mv -k` on a directory whose own rename fails (case-only `mv -k d D`, too-long
`mv -k d S300`; git 2.56.0, both `core.ignorecase` values, 2/2) skips the failed rename, still
moves the children's index entries to the destination, then deletes the source directory recursively — untracked
files included — and exits 0. For a file source whose rename the host refuses, `git mv -k` skips
the pair and moves nothing (ledger row 32.72).

## Options considered

1. **Copy git's observable outcome on both arms, data loss included**, and record the upstream
   defect here.
2. Refuse with nothing changed — a deliberate divergence.
3. Skip the pair safely with a new `MvSkipReason` — a new public union member.

## Decision

Option 1, ratified by the user against the design's recommendation (option 2), consistent with
ADR-936 and ADR-937: faithfulness binds git's binary, its data-destroying arms included.

The file arm of ledger row 32.72 runs through the same execution-time catch, so it is folded here
(DOCTRINE D-2): a refused file rename under `skipErrors` is skipped as git skips it.

## Consequences

`skipErrors` swallows an execution-time rename refusal and reproduces git's resulting index and
work tree. A caller relying on `skipErrors` to keep untracked content safe loses it exactly where
git loses it. Without `skipErrors`, ADR-1219 governs. The row leaves `docs/known-divergences.md`.
