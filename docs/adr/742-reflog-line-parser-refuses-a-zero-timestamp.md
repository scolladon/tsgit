# ADR-742: Reflog line parser refuses a zero timestamp

## Status

Accepted (at `fc54f8cd`) — adopted-as-recommended (no user judgment)

## Context

Four per-line predicate divergences are pinned (design doc §1a rows 20–23): git
accepts a `>`-only identity tsgit rejects, and rejects `>`-in-name, no-space-after-`>`,
and zero-timestamp lines tsgit accepts. Aligning all four means changing
`parseIdentity`, which is shared with commit and tag object parsing — where git
uses a *different* parser, so "align on git" is not even one thing there. Row 23
is different in kind: `serializeReflogLine` will emit `… 0 +0000` for a
zero-timestamp entry, and git reads that line as corrupt and silently drops it —
tsgit writing a file git cannot fully read, which the prime directive binds.

## Decision

`parseReflogLine` refuses a zero timestamp (in `reflog-format.ts`, without
touching `parseIdentity`). Rows 20–22 stay recorded, pinned-as-divergent in the
interop suite.

## Consequences

### Positive

- Closes the only row that breaks a round trip through tsgit's own writer.
- `parseIdentity`'s blast radius (commit/tag parsing) stays untouched.

### Negative

- Rows 20–22 remain knowing divergences, asserted rather than fixed.

### Neutral

- Whether the writer should also refuse timestamp 0 at append time is left to the
  implementation's round-trip test to force if needed.
