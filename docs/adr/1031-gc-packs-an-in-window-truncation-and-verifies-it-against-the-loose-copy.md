---
subjects:
  - src/application/commands/internal/gc-pipeline.ts
---
# 1031 — gc packs an in-window truncation and verifies it against the loose copy

- **Status:** accepted
- **Date:** 2026-10-21
- **Design:** docs/design/gc-size-lying-loose-blob.md (D6, G5–G6) · **Supersedes/Refines:** refines ADR-907 (the in-window truncation reaches the pack)

## Context

Pinned on git 2.55.0: a loose blob whose body overruns its claim while still fitting the 32-byte
header window (claims 5, has 10) is packed by `gc` as the 5-byte truncation, exit 0, the loose
file pruned; a later `git fsck` reports `error: packed <oid> from <pack> is corrupt`, exit 4.
tsgit's buffered tier already truncates such a read (ADR-907), so with ADR-1028 the pack entry
holds the 5 bytes git writes. gc's own post-write `verifyPacked` (`readObject { verifyHash:
true }`, a step git does not have) would then refuse the entry's hash mismatch where git exits 0.

## Options considered

1. **Match git: pack the truncation; `verifyPacked` accepts the mismatch only when the id's
   loose copy reads through the buffered tier with the `'truncate'` verdict and bytes identical to
   the packed entry; gc prunes the loose file** (recommended) — pros: git's data and exit status;
   no cost on the honest path / cons: a knowingly mis-hashed entry is written, as git writes it.
2. **Keep refusing after the write** — cons: diverges on exit status and leaves the pack
   registered with the loose file intact.
3. **Refuse before the write, like a past-window overrun** — cons: diverges on exit status and on
   the packed data.

## Decision

**Adopted-as-recommended (no user judgment): option 1** — the git-faithful standing rule
(ADR-226). `verifyPacked` keeps refusing every other hash mismatch: the acceptance needs both
conditions, a `'truncate'` verdict on the loose copy and byte-equal content, each pinned by its
own test.

## Consequences

G5 and G6 reach git's exit 0 and the same `cat-file -s` on both twins; a real `git fsck` on both
twins exits 4 on the packed entry. The under-run (claims 200, has 5), which git pads, stays
ADR-907's carried-forward residual and is out of scope.
