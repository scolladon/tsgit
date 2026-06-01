# ADR-237: squash/fixup chains are reproduced fully faithfully

## Status

Accepted (at `2e17819f`)

## Context

A run of ≥2 consecutive `squash`/`fixup` instructions forms a *group* melding
into the preceding commit. Verified against git 2.54, git does **not** produce a
single combined commit at the group's end; it commits **after each group
member** with the *running* combined message and only **cleans** the message
when the group ends:

```
pick A, fixup B, fixup C  →  HEAD reflog:
  rebase (start): checkout …            (A folded)
  rebase (fixup): # This is a combination of 2 commits.   (A+B, running template)
  rebase (fixup): A-subject                                (A+B+C, cleaned)
```

So a chain of length _n_ leaves _n_ intermediate commits and _n_ reflog entries
whose subjects are the commit's first message line *at commit time* — the
templated `# This is a combination of N commits.` until the final, cleaned
entry. The in-flight group is tracked on disk by `current-fixups`,
`message-squash`, and `rewritten-pending` for cross-tool resume.

Two fidelity levels were surfaced:

1. **Final-state faithful (collapse)** — one combined commit + one final reflog
   entry per group; faithful final tree/message/count/last-reflog, divergent only
   in the transient intermediate chain reflog + dangling objects.
2. **Fully faithful** — reproduce git's per-member intermediate commits, running
   template message, and intermediate reflog subjects, cleaning only at chain
   end.

## Decision

**Option 2 — fully faithful chains.** The interactive engine threads a *running
combined message* in template form, commits each squash/fixup member as it is
processed (so the intermediate commit + `rebase (squash|fixup): <running first
line>` reflog appear), and cleans the message (comment strip → final subject)
only when the next instruction is not a squash/fixup or the todo ends. The
group's on-disk markers (`current-fixups`, `message-squash`, `rewritten-pending`)
are written byte-faithfully so a mid-chain stop is cross-tool resumable. Author
of the whole group is the first member's author (via `author-script`); committer
is the current identity.

This upholds the prime directive (ADR-226) with **no documented divergence** —
the alternative would have left the reflog and object store observably different
from git for any chain of length ≥2.

## Consequences

### Positive

- Byte-faithful even mid-chain: reflog subjects, intermediate (dangling) commit
  objects, and the `current-fixups`/`message-squash`/`rewritten-pending` resume
  state all match git. No ADR-226 exception.

### Negative

- Materially more engine state than a collapse: a running message accumulator,
  per-member commit + reflog, the comment-strip-at-end transition, and three
  extra state files to write/read/clear.

### Neutral

- The combination-template builder and its comment-strip reduction live in
  `domain/rebase/squash-message` (ADR-234), shared by the defaulted squash
  message and the chain accumulator.
