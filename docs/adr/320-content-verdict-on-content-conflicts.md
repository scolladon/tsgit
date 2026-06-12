# ADR-320: `contentVerdict: 'clean'` extends to mode-conflicted `content` conflicts

## Status

Accepted (at `<sha-after-merge>`)

## Context

ADR-310 introduced `contentVerdict: 'clean' | 'content' | 'binary'` scoped to
`add-add` conflicts only. The with-base work surfaces a new shape: same-kind
regular sides under a **kind-changed base** run a base-less (two-way) content
merge; when the content merges clean but the two sides' **modes differ**
(100644 vs 100755), git keeps the path conflicted — three stages — while the
worktree carries the clean merged bytes. Verified against git 2.54.0 ort
(including `merge=union` resolving such a pair clean, exit 0).

Without a verdict, a consumer can only infer cleanness by scanning
`conflictContent` for the absence of markers — implicit and fragile.

## Decision

Carry **`contentVerdict: 'clean'`** on `content`-typed conflicts whose merged
bytes are clean but whose path stays conflicted for mode reasons. This amends
ADR-310's "conflict types other than `add-add` never carry `contentVerdict`"
clause: the field is now valid on `add-add` **and** `content` conflicts, with
the same value semantics.

## Consequences

### Positive

- Symmetric with 24.9f's add/add shape; consumers distinguish mode-only
  conflicts from real content conflicts with one field read.

### Negative

- ADR-310's invariant narrows; existing consumers that assumed the field
  implies `add-add` must check `type`.

### Neutral

- `content` conflicts produced by the ordinary marker path may keep omitting
  the verdict (`'content'` is implied by markers); only the clean-bytes case
  requires it.
