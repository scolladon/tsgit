# ADR-129: Parity scenarios are additive in 19.5; duplicate ad-hoc browser specs are retired in 19.5a

## Status

Accepted (at `91dfcc674ca8fd0bb818b6b9869b1700cf7919b4`)

## Context

Phase 19.5 ships two parity scenarios: `init-add-commit-status` and `branch-lifecycle`. Both overlap heavily with existing browser-only specs:

- `init-add-commit-status` overlaps `test/browser/opfs-roundtrip.spec.ts`.
- `branch-lifecycle` overlaps the `branch` `describe` block inside `test/browser/surface-parity.spec.ts`.

Two options for the 19.5 PR:

1. **Delete the duplicates in the same PR.** Pro: net diff is smaller and the suite stays trim. Con: deletion is a subjective call per spec — some assertions in the ad-hoc spec may exercise nuances the parity scenario does not (e.g. `opfs-roundtrip.spec.ts` asserts `init.bare === false`, which is in `EXPECTED.init.bare` but only one of many fields). Reviewers must reason about both the new infrastructure and the deletion criteria in one sitting, multiplying review cost.
2. **Keep the ad-hoc specs in place; treat the parity layer as additive.** Pro: 19.5 reviews exactly one thing — the parity infrastructure. The 19.5a audit (Playwright surface coverage audit, already on the BACKLOG) has explicit license to do duplicate detection — the same machinery that identifies coverage gaps identifies coverage overlaps. Con: the suite briefly carries duplicate coverage between 19.5 and 19.5a.

The project's stated value (CLAUDE.md → "Edits: diff-minded, not full-file rewrites" and the convergent design loop's preference for tight diffs) and the prior ADR-126 precedent (append-only sweep, defer prose normalization to a follow-up) both tilt strongly toward option 2.

## Decision

19.5 lands the parity infrastructure (drivers, fixtures, audit lint, two scenarios, CI wiring) without deleting any existing browser specs. 19.5a's gap audit identifies which ad-hoc specs are pure duplicates of a parity scenario — the audit's heuristic is: "ad-hoc spec X is a duplicate of parity scenario Y if every assertion in X is implied by `EXPECTED` in Y." Confirmed duplicates are removed in 19.5a's PR.

## Consequences

### Positive

- **19.5 is reviewable in one sitting.** The diff is: scenario infrastructure + two scenarios + audit lint + CI wiring. No deletions; no need to justify per-spec why removal is safe.
- **19.5a inherits a concrete deletion criterion.** "Implied by `EXPECTED`" is mechanical — the audit can compute it. No subjective per-spec review.
- **Brief duplicate coverage is benign.** The duplicated cycles are seconds per Playwright run; the parity layer catches what the ad-hoc spec catches plus the Node and Memory drift the ad-hoc spec misses.

### Negative

- **Two surfaces test the same git operations between 19.5 and 19.5a.** Accepted — duration is bounded by the 19.5a turnaround. No correctness risk; just minor CI time waste.
- **`test/browser/` carries a temporary file count bump.** New `parity.spec.ts` sits alongside the four existing specs until 19.5a prunes. Acceptable — the file count is small and the directory is well-organized.

### Neutral

- **Hash-interop and decompression-stream specs are *not* duplicates.** They prove `BrowserHashService` SHA-1 parity and `BrowserCompressor` deflate/inflate via Web Streams — both browser-engine-specific behavior with no Node/Memory analogue. 19.5a's audit explicitly keeps them.
