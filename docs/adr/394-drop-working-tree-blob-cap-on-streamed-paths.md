# ADR-394: Streamed merge/stash materialisation drops the 256 MiB blob cap (matches git and checkout)

## Status

Accepted

- **Date:** 2026-06-20
- **Design:** [design/blob-streaming.md](../design/blob-streaming.md)
- **Refines:** [ADR-392](392-comprehensive-blob-materialisation-sweep.md)
- **Relates:** [ADR-024](024-bounded-reads-where-cap-fires.md), [ADR-032](032-add-all-large-file-guard.md)

## Context

Converting the merge clean-survivor and stash-restore sites (B/C/D in the design's
in-scope table) to streaming raised whether to preserve their `maxBytes: 256 MiB`
reject ceiling (`MAX_WORKING_TREE_BLOB_BYTES` / `MAX_CONFLICT_OUTPUT_BYTES`). Established
facts:

- The cap is a tsgit **memory guard** (ADR-024: reject too-large inputs "before they
  materialise"), not git behaviour. Canonical `git checkout`/`merge`/`stash` impose **no**
  working-tree file-size limit — `core.bigFileThreshold` changes handling, never rejects.
- The cap is **opt-in** (`readObject({ maxBytes })`). The checkout hot path
  (`apply-changeset.ts:167`, site A) already calls `readBlob(id)` with **no** `maxBytes`,
  so checkout already accepts arbitrarily large blobs (git-faithful), merely buffering
  them — the OOM risk this feature removes. Only sites B/C/D pass the cap, so only they
  *reject* big files — an inconsistency with both checkout and git.
- Streaming bounds memory for loose and packed-base blobs. Deltified blobs still fully
  reconstruct (ADR-386) — but site A already tolerates that uncapped today.

So preserving the cap on B/C/D would keep a divergence git does not have and that
checkout already lives without.

## Options considered

1. **(chosen) Drop the cap on the converted sites** — B/C/D call `streamBlob(id)` →
   `writeStream` with no size ceiling, matching site A and git — pros: removes a
   git-divergence (merge/stash now accept what checkout and git accept); consistent
   posture across all working-tree materialisation; `streamBlob` needs **no** `maxBytes`
   (its ratified `{ verifyHash }` surface is unchanged — simpler); the residual
   deltified-blob OOM edge is the *same* one site A already accepts / cons: removes a
   security-reviewed defensive ceiling on the merge/stash paths (mitigated: it never
   protected checkout, the dominant path, anyway).
2. **Preserve the cap via a new `streamBlob({ maxBytes })`** — Rejected: keeps the
   git-divergence and adds public API surface for a guard checkout already proves
   unnecessary.
3. **Hybrid — cap only the deltified (still-buffering) path** — Rejected: makes a file's
   acceptance depend on whether git happened to deltify it (storage-form-dependent
   rejection), itself a weird divergence git does not have.

## Decision

The converted sites B/C/D drop their `maxBytes` argument and stream uncapped, matching
site A (checkout) and canonical git. `streamBlob` keeps its ratified `{ verifyHash }`
options surface — no `maxBytes` is added. The constants `MAX_WORKING_TREE_BLOB_BYTES` and
`MAX_CONFLICT_OUTPUT_BYTES` remain for their other consumers (`add --all`'s read-side
guard per ADR-032; the excluded conflict-materialisation sites E–I).

## Consequences

### Positive

- Removes a tsgit-only divergence: merge/stash now accept arbitrarily large files, like
  git and like checkout. More faithful, and consistent across the working tree.
- `streamBlob` stays minimal (no `maxBytes`).

### Negative

- A hostile deltified multi-GiB object on the merge/stash path is no longer rejected
  pre-materialisation — the same residual risk checkout already carries; not newly
  introduced for checkout, only extended to merge/stash.

### Neutral

- The cap constants live on for `add --all` and the conflict-materialisation sites, which
  are out of this feature's scope.
