---
subjects:
  - src/application/primitives/object-resolver.ts
  - src/application/primitives/read-object.ts
  - src/application/commands/internal/fsck/object-cache.ts
---
# 1021 — A REF delta cycle refuses as an invalid pack entry

- **Status:** accepted
- **Date:** 2026-10-20
- **Design:** docs/design/lift-delta-chain-read-cap.md (DC-3, §1 M8–M9) · **Supersedes/Refines:** refines ADR-1019; knowing divergence from git (recorded here)

## Context

Pinned on git 2.56 and 2.55: on a REF_DELTA that names its own id, and on two REF_DELTAs naming
each other, `git cat-file -t`, `cat-file -p`, `fsck --full` and `cat-file --batch-all-objects
--batch-check` never exit — ~90 % CPU with RSS growing from ~170 MB to ~280 MB in six seconds
(2.56) and ~266 MB to ~648 MB (2.55). Only `cat-file -s` returns, because it reads the size from
the delta header without walking. There is no git behaviour to be faithful to; a library cannot
hang, so any terminating answer diverges and only the refusal's shape is open. The index pass
already refuses cycles at fetch (ADR-784), so this reaches the read path only through a
hand-built or locally corrupted `.idx`.

## Options considered

1. **`INVALID_PACK_ENTRY { offset, reason: 'delta base cycle' }`** via the existing
   `invalidPackEntry`; fsck stored-type reason `'delta chain cycle'` (recommended) — pros: the
   existing structured code for "this pack entry is unusable", already in fsck's
   `CORRUPTION_CODES`; no API change, so it ships unchanged on a 5.0.x hotfix / cons: a caller
   must read `reason` to tell a cycle from another bad entry.
2. **A new `DELTA_BASE_CYCLE { id }` variant** — pros: precise for a caller branching on cycles /
   cons: a public variant for a shape only a hand-built `.idx` produces.
3. **Repurpose `DELTA_CHAIN_TOO_DEEP`** — pros: no new string / cons: a name that says "too
   deep" for a walk that is not deep, with a `depth` field that has no meaning.

## Decision

**User-ratified: option 1.** The resolver and `readObjectMetadata` throw
`invalidPackEntry(offset, 'delta base cycle')`, where `offset` is the REF_DELTA entry that would
close the cycle; fsck's stored-type recovery returns its own untyped fault with reason
`'delta chain cycle'`. This is a recorded divergence from git, whose answer is a hang.

## Consequences

`isStoredCorruption` classifies the refusal without edits. `docs/use/errors.md`'s
`INVALID_PACK_ENTRY` row gains the reason. REF cycles are pinned by unit tests only: asserting
git's hang would cost a timeout per case on every CI run, so this record and the design's matrix
are the record of git's behaviour.
