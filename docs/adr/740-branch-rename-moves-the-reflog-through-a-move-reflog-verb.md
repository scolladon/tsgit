# ADR-740: Branch rename moves the reflog through a moveReflog verb

## Status

Accepted (at `fc54f8cd`) — ratified by the user

## Context

`git branch -m` moves the reflog file byte-for-byte (measured: a malformed line
survives verbatim under the new name, then the rename entry is appended). tsgit's
`branchRename` does read → concatenate → re-serialize, so no parse tolerance can
reproduce git: a strict read refuses the rename on a corrupt log; a lenient read
silently drops the line git preserves. Alternatives: stay strict and record the
divergence (fails loudly where git succeeds); go lenient and accept the drop
(hides data loss).

## Decision

Add a store-level `moveReflog(from, to)` verb: the files backend moves the log
file byte-preserving (plus the appended rename entry), the reftable backend
re-keys the log records. `branch.ts` drops its read-concat-rewrite in favour of
the verb.

## Consequences

### Positive

- The only faithful shape: corrupt bytes survive a rename exactly as under git.
- Removes a strict read site instead of converting it.

### Negative

- A second new seam verb with a reftable half — the largest scope add in this
  change.

### Neutral

- The appended rename entry still goes through the normal append serializer.
