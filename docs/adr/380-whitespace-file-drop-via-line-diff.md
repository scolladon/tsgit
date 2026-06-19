# ADR-380: Whitespace-only file drop reuses the mode-normalized `diffLines`

## Status

Accepted

- **Date:** 2026-06-20
- **Design:** [design/whitespace-diff-options.md](../design/whitespace-diff-options.md)
- **Refines:** [ADR-378](378-whitespace-options-flat-enum.md)

## Context

Under an active **line-key** whitespace mode (`-w` / `-b` / `--ignore-space-at-eol` /
`--ignore-cr-at-eol`), git removes a file whose only change normalizes away **entirely**
from the change-set: it is absent from `--name-status`, `--numstat`, and `--raw` (not shown
as an empty modify). tsgit's `domainDiffTrees` classifies such an edit as a `modify`
because the blob OIDs differ. A post-classification drop pass is therefore required, and
its predicate is a load-bearing faithfulness choice. (Pinned against real git 2.54.0:
`--ignore-blank-lines` alone is the exception — it suppresses hunks/numstat but keeps the
file as `M` in name-status/raw, so it is NOT a drop trigger; see ADR-379.)

## Options considered

1. **(chosen) Drop via mode-normalized `diffLines`** — drop a `modify` iff its
   mode-normalized `diffLines` yields zero `ours-only`/`theirs-only` hunks (after
   blank-line suppression, ADR-379); binary and type-changes never drop — pros: reuses
   the exact line diff the patch/stat path already runs (one line diff per file, not two),
   so the drop can never disagree with the emitted patch/counts / cons: the drop pass must
   hydrate blobs (I/O) — placed in the primitive tier, not the domain classifier.
2. **Cheap normalized-bytes-equal pre-check** before any line diff — Rejected for now:
   duplicates normalization and can disagree with the line-diff result at edges (trailing
   newline, blank-line suppression); admissible only as a later behavior-preserving
   optimization.
3. **Never drop** (keep an empty `modify`, let callers filter) — Rejected: diverges from
   git's `--name-status`/`--raw`/`--numstat`, which omit the file.

## Decision

When a **line-key** whitespace mode is active, `diffTrees` runs a drop pass that removes a
`modify` whose mode-normalized `diffLines` produces no changed hunks. Binary files and
type-changes are never dropped (git keeps them; the line diff never runs for binaries).
`--ignore-blank-lines` alone does **not** trigger the drop — it only empties the hunks/stat
of a file that stays in the change-set (ADR-379); the combined `--ignore-blank-lines` +
line-key case drops because the line-key normalization makes the change whitespace-only
(pinned in the design matrix). The normalized `diffLines` computed for the drop is reused
by the stat/patch path when those are also requested — one line diff per file. With no
mode active, the OID-only fast path is unchanged: zero new blob reads for a default diff.

## Consequences

- The drop pass is primitive-tier (it does blob I/O via the same bounded pool as
  `attachStats` / `materialisePatchFiles`); the pure domain classifier still sees only
  OIDs (dependency rule preserved).
- `--numstat` shows the dropped file as absent, never `0 0` — matching git.
- Reusing one `diffLines` per file guarantees the drop decision, the emitted patch, and
  the stat counts are always mutually consistent.
- The drop runs after rename/copy detection, which scores on raw bytes (ADR-381 / the
  similarity invariant): a whitespace-only *rename* still pairs.
