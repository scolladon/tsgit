# ADR-161: Wave-0 harness extension — wire doc-links + mutation-budgets into validate

## Status

Accepted (at `1c35bc3`)

## Context

`package.json` defines two scripts that the spike's §14.3 validation gates
depend on:

- `check:doc-links` (line 197) — verifies that markdown cross-references in
  `docs/` resolve.
- `check:mutation-budgets` (line 204) — verifies the per-file mutation-survivor
  budgets file is honored.

Both exist as scripts but neither is invoked by `npm run validate`
(lines 693–715). They run today only as manual hygiene.

Phase 20.1 design relies on both as PR-blocking gates:

- doc-links because the spike introduces docs across `docs/use/snapshots.md`,
  `docs/understand/caching.md`, and updates to multiple existing pages.
- mutation-budgets because the new caching layer + `join` + `GenerationView`
  must have 0 surviving mutants (per CLAUDE.md mutation-budget rule).

Two options:

1. **Drop the gates from the §14.3 design** — 20.1 commits only to checks
   already wired. doc-links + mutation-budgets stay as separate manual hygiene.
2. **Wire them into validate as part of 20.1** — a small, defensible scope
   addition. Makes the design's stated gates match what CI actually runs.

## Decision

Wave 0 of the 20.1 PR adds both scripts to the `validate` chain. ADR-only
change: no business logic, no API surface change. Self-contained, separable
from the snapshot work — Wave 0 can land independently if 20.1 needs to be
split (per ADR-151's PR-split fallback).

## Consequences

### Positive

- Design's stated gates match the gate set CI runs. No "we'll add this later".
- doc-links + mutation-budgets become PR-blocking everywhere in the repo,
  not just 20.1. Strengthens the harness for all future work.
- One-line edit to `package.json` — minimal blast radius.

### Negative

- Existing in-flight PRs without doc updates may hit doc-links failures after
  Wave 0 lands. Mitigated: Wave 0 runs the checks across the whole repo
  before any 20.1 code; any breakage is fixed in Wave 0 itself.
- Mutation budgets file becomes load-bearing for every PR. Entries must be
  maintained as code lands. Mitigated by the spike's design — mutation
  budgets are per-file, kept inline with the work.

### Neutral

- Wave 0 is the first commit of the 20.1 PR — runs once, sets the baseline,
  then snapshot work proceeds against a green harness.
- Pattern reusable for future "wire previously-manual check into validate"
  follow-ups.
