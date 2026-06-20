# ADR-393: Streamed working-tree writes go straight into the final path (git-faithful, non-atomic)

## Status

Accepted

- **Date:** 2026-06-20
- **Design:** [design/blob-streaming.md](../design/blob-streaming.md)
- **Refines:** [ADR-389](389-incremental-stream-hash-verification.md), [ADR-392](392-comprehensive-blob-materialisation-sweep.md)

## Context

The buffered checkout path today verifies the blob hash **before** writing: `readBlob`
materialises and verifies the whole object (verifyHash default-on), *then*
`writeWorkingTreeEntry` writes it. The streaming path verifies at **end-of-stream**
(ADR-389), so the write consumes chunks before the hash is confirmed. On a corrupt or
aborted blob the write can leave a partial/whole-but-unverified file on disk — a real
behaviour change from the buffered path. The decision is whether to accept that
(git-faithful) or restore pre-publish safety (more atomic than git).

Faithfulness pinned against `git version 2.54.0` (`mktemp` throwaway): `git checkout`
replaces a path with a **new** file object (inode changes; a hardlink to the old content
keeps the old bytes), and its working-tree writes are **non-atomic** — a mid-write crash
can leave a short/partial new file. git does not write-temp-then-rename for regular
working-tree entries (`entry.c`).

## Options considered

1. **(chosen) Stream straight into the final path after `rmIfExists`** — pros: faithful
   to git's non-atomic, replace-not-truncate working-tree write (invents no divergence);
   simplest; preserves the `rmIfExists`-then-write order that is also the symlink-safety;
   a partial file on crash/corruption is "no worse than git" / cons: loses the buffered
   path's pre-write verification — a corrupt blob can publish bad/partial bytes before
   `objectHashMismatch` throws at end-of-stream.
2. **Temp-path + verify-at-end + rename into place** — Rejected: it would *close* the
   verification hole (a corrupt/partial blob never publishes), but it makes tsgit
   deliberately **more atomic than git** — an explicit divergence from observable
   crash behaviour — and adds temp-name + rename + cleanup-on-failure logic. Recorded as
   the considered alternative; not chosen because the prime directive favours matching
   git absent a compelling reason, and git is itself non-atomic here.
3. **Keep buffered+verify-then-write for the checkout consumer** — Rejected: abandons the
   write-side memory win (the chosen scope, ADR-392).

## Decision

The streaming write (`writeStream`, ADR-390) writes directly into the final working-tree
path after `rmIfExists`, with no temp file or rename. Verification stays end-of-stream
(ADR-389); a corrupt/aborted blob may leave a partial file, matching git's non-atomic
working-tree write semantics. This is the faithful default, not an accidental regression.

## Consequences

### Positive

- Faithful to git's non-atomic replace; simplest; symlink-safety order preserved.

### Negative

- A corrupt/aborted blob can leave a partial/unverified working-tree file (no worse than
  git; a regression only relative to tsgit's own buffered pre-write verification).

### Neutral

- A temp+rename atomic-publish mode remains a future opt-in if a consumer ever needs
  stronger-than-git guarantees (it would be a documented divergence).
