# ADR-198: `pull` omits the `rebase` mode until rebase (22.3) lands

## Status

Accepted (at `1dbd41e`)

## Context

`git pull` integrates either by merge (default) or by rebase (`--rebase` /
`pull.rebase`). tsgit's rebase command is Phase 22.3 and has not landed. The
`rebase` option on `pull` therefore cannot do anything useful yet. Two shapes
were considered:

1. **Omit entirely** — no `rebase` field on `PullOptions` until rebase exists;
   add it in the same PR that ships rebase.
2. **Present but throws** — `pull({ rebase: true })` typechecks now and throws
   `UNSUPPORTED_OPERATION` until 22.3 wires it (forward-compatible surface).

## Decision

Adopt option 1 (**omit entirely**). `PullOptions` has no `rebase` field until
22.3; the rebase integration mode is added in the PR that ships rebase.

## Consequences

### Positive

- YAGNI — no dead throw-path to implement, document, and test for 100%
  coverage / 0 surviving mutants.
- Cleanest public surface; the option appears exactly when it works.

### Negative

- Adding `rebase` later is an additive surface change (non-breaking) in the
  22.3 PR rather than now.

### Neutral

- `pull` ships merge-only integration; the design's composition framing already
  anticipates the 22.3 follow-up.
