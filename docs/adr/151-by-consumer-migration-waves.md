# ADR-151: By-consumer migration waves (not by-walker)

## Status

Accepted (at `1c35bc3`)

## Context

Phase 20.1 introduces `snapshot+join` and migrates existing `walkTree`/
`walkWorkingTree` consumers. Two migration shapes:

1. **By-walker** — Wave 1 introduces the new primitive; Wave 2 deletes
   `walkTree`; Wave 3 deletes `walkWorkingTree`.
2. **By-consumer** — Wave 1 introduces; Waves 2–7 each migrate one consumer
   (status, diff, add, checkout, merge, rest); Wave 8 deprecates old walkers
   (now zero internal callers).

Spike v1 used by-walker. Review pass 1 caught the problem:

- `walkSubmodules.ts` imports `walkTree(ctx, tree, { recursive: true })`.
  Wave 2 cannot delete `walkTree` while submodule code still consumes it.
- `commands/status.ts` calls `walkWorkingTree`. Wave 1 ports `status` as a
  pilot, creating dual code paths for the same operation in the same wave.

By-walker forces either a wave to ship inconsistent (some callers migrated,
some not) or a wave to keep the old walker around (defeating the deletion).

## Decision

Migrate by-consumer. Each wave migrates one command (or a small cluster of
related primitives) and is internally consistent. Old walkers stay
authoritative until all consumers are migrated; then Wave 8 deprecates them
as `@deprecated` facades over the new API.

Wave structure (see spike §11):

| Wave | Scope |
|---|---|
| 0 | Harness wiring (doc-links + mutation-budgets into validate) |
| 1 | Introduce snapshot+join primitive; no consumer migrated |
| 2–6 | One command per wave (status, diff, add, checkout, merge) |
| 7 | Remaining consumers + walkSubmodules internals |
| 8 | Deprecate walkers as facades |

## Consequences

### Positive

- Every wave is internally consistent. No "Wave 1 introduces but also
  migrates one consumer".
- Rollback is clean per wave. After any Wave N (where N ≥ 1), the codebase
  is shippable.
- Each wave is small (one command + its tests + parity-fixture validation),
  reviewable independently.
- PR can split at the last green wave if a later one stalls (e.g., checkout
  uncovers a hard edge case mid-implementation). Subsequent waves ship as
  follow-up PRs against the deprecated-walker baseline of Wave 1.

### Negative

- 8 waves vs. 3 — more commits in the PR. Mitigated: each is small and
  mechanical after Wave 1.
- Old walkers stay in the codebase longer (until Wave 8). Mitigated:
  `check:dead-code` (knip) detects orphans; we know exactly when Wave 8
  becomes mechanical.

### Neutral

- ADR-152 covers the semver impact of Wave 8's facade approach.
