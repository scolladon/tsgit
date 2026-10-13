---
subjects:
  - src/domain/merge/strategy-options.ts
  - src/domain/merge/three-way-tree.ts
  - src/application/primitives/build-content-merger.ts
  - src/application/primitives/internal/merge-rename-config.ts
  - src/application/commands/merge.ts
  - src/application/commands/add.ts
  - src/application/commands/cherry-pick.ts
  - src/application/commands/revert.ts
  - src/application/commands/rebase.ts
  - src/application/commands/stash.ts
  - src/application/commands/pull.ts
---
# 956 — Renormalization covers every merge-ort consumer and `add --renormalize`

- **Status:** accepted
- **Date:** 2026-10-12
- **Design:** docs/design/eol-conversion.md · **Supersedes/Refines:** refines ADR-945

## Context

tsgit refuses `-X renormalize` because it had no conversion. Pinned in §D1.12 of the design, git's
renormalization is one buffer function (`renormalize_buffer`: to-worktree without CRLF unless a
smudge/process driver, then to-git) reached from several places: `merge -X renormalize` /
`-X no-renormalize`; the `merge.renormalize` key honoured by merge, cherry-pick, revert, rebase,
stash apply and pull; normalization of base, ours and theirs **before** the merge driver is chosen;
the modify/delete rule (`blob_unchanged`: a side whose only change is renormalization against a
deleting side merges as a clean delete); and `add --renormalize`, which restages tracked,
non-skip-worktree entries at their normalized bytes and never adds untracked paths. The attribute
source is the merged `.gitattributes`, with git's base-governs rule when the file needed a content
merge.

## Options considered

1. **Full git scope** — everything above, one `renormalizeBuffer` (recommended). Cons: eleven
   subjects touched.
2. **`merge -X renormalize` and `add --renormalize` only** — config and the other consumers later.
   Cons: cherry-pick and rebase with `merge.renormalize=true` conflict where git merges cleanly.
3. **Full scope without the modify/delete rule** — cons: one pinned divergence remains.

## Decision

**User-ratified — option 1.** The refusal in `strategy-options.ts` is lifted;
`OrtStrategyOptions.renormalize` takes `merge.renormalize` as its default and `-X` wins. Consumers
without `-X` (cherry-pick, revert, rebase, stash apply, pull) read the key. `buildContentMerger`
passes the three sides through `renormalizeBuffer` before `resolvePathMergeSpec`, so external,
union and binary drivers see normalized bytes; the merged result is written as is and reaches the
worktree through the to-worktree route. `three-way-tree.ts` gains an optional `BlobUnchanged`
callback turning a modify/delete into a clean delete when modes are equal and the ids or the
renormalized bytes are equal, except across a rename. `add({ renormalize: true })` follows
`renormalize_tracked_files`. An invalid `merge.renormalize` refuses merge-family commands only.

## Consequences

- Renormalization never arms the safecrlf check and ignores the index-CRLF rule (§D1.6, §D1.5).
- The merged-`.gitattributes` rule — the result when the file resolved without a content merge,
  else the base, else ours — is an upstream quirk transcribed as pinned.
- The `merge.ts` comment that documented the refusal is rewritten; the use pages for cherry-pick,
  revert, rebase, stash and pull name `merge.renormalize`.
