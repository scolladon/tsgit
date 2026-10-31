---
subjects:
  - src/application/commands/internal/fsck/types.ts
  - src/application/commands/internal/fsck/refs-verify.ts
  - src/application/primitives/ref-store.ts
---
# 1127 — fsck reports an unreadable ref path in the walk as a path-keyed finding

- **Status:** accepted
- **Date:** 2026-10-30
- **Design:** docs/design/fsck-broken-ref-chain-unreadable.md (D7) · **Supersedes/Refines:** refines ADR-1122 and ADR-1126

## Context

git 2.56.0's refs walk prints `warning: error opening directory '<dir>/': Permission denied` for a
mode-000 directory and `failed to stat '<path>'` when a path cannot be stat'd, and exits 0 for both.
Neither text is an fsck msg-id, so `fsck.<id>` cannot re-type them, and a directory has no ref name.

## Options considered

1. **A new `FsckFinding` arm `{ type: 'unreadable-ref-path'; path; operation: 'open-directory' |
   'stat'; reason: 'PERMISSION_DENIED' }`, no exit bit, gated by `checkReferences`** (designer's
   recommendation) — pros: follows the path-keyed `pack-inaccessible` precedent, keeps `bad-ref` to
   git's catalogue / cons: one more arm in the union.
2. **`bad-ref` with tsgit-invented msgIds** — cons: non-git ids where consumers expect git's, and a
   `RefName` for a directory.
3. **`cannotReadRef` at warning with an `operation` field** — cons: overloads a fixed-error git message.

## Decision

**Ratified by the user: option 1.** The walk's two warnings are `unreadable-ref-path` findings with
the absolute `path`, the `operation` and `reason: 'PERMISSION_DENIED'`. They set no exit bit,
appear only under `checkReferences`, and are never re-typed. A read fault whose `lstat` also fails is
git's `failed to stat`, not `cannotReadRef`.

## Consequences

- `FsckFinding` gains one arm; consumers that switch on `type` see it.
- The listing commands skip the directory silently, with no finding.
