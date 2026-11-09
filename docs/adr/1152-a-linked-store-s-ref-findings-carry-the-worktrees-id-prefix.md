---
subjects:
  - src/application/primitives/ref-store.ts
  - src/application/commands/internal/fsck/refs-verify.ts
  - src/application/commands/internal/fsck/roots.ts
  - test/integration/fsck-broken-ref-chain-interop.test.ts
---
# 1152 — a linked store's ref findings carry the worktrees/<id>/ prefix in ref

- **Status:** accepted
- **Date:** 2026-11-07
- **Design:** docs/design/fsck-worktree-private-refs.md · **Supersedes/Refines:** refines ADR-249, ADR-1150

## Context

git names a linked store's refs `worktrees/<id>/<bare name>` in every `refs verify` line, the
current linked worktree's own refs included (A2, B2, B5 from the linked worktree), and keeps the
bare name on the pointer line (`invalid sha1 pointer`), which comes from the current view's
listing. `worktrees/<id>/HEAD` is a real refname that `rev-parse` accepts (B14), not a display
form. tsgit's `unreadableHeadFinding` already reports `ref: 'worktrees/wt/HEAD'`, while its
content findings on the linked route are bare and the interop suite rebuilds the prefix
(`shownRef`). A consumer on a linked working directory sees the `ref` value change.

## Options considered

1. **The prefix in `ref`** (`worktrees/<id>/…` for every linked store, bare for the main store)
   — pros: git's name is the datum; unique across stores; matches the existing precedent / cons:
   a breaking data change on linked-cwd results. The designer's recommendation.
2. **Bare `ref` plus `worktree?: string`** — cons: consumers rebuild git's name; HEAD naming
   stays inconsistent with the reflog pass.
3. **Both** — cons: two sources of truth for one fact.

## Decision

**Ratified by the user: option 1.** A finding of the main store carries git's bare name. A
finding of a linked store carries `worktrees/<id>/` followed by the bare name, including the
current linked worktree's own refs. `badRefOid` pointers keep the current view's bare names.
The main store's unreadable HEAD seen from a linked working directory is named `HEAD`, git's
line (pin P2), no longer `main-worktree/HEAD`. The interop suite drops `shownRef`.

## Consequences

- Breaking data change, named in the changelog: on a linked working directory the content
  finding's `ref` gains the prefix; P2's `ref` changes to `HEAD`.
- Root-ref decisions in `refs-verify.ts` work on the bare name (`bareStoreRefName`).
- The interop suite rebuilds git's lines from `ref` directly.
