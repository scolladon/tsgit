# 406 — active-driver filter support: v1 spans diff (textconv) + checkout/add (clean/smudge)

- **Status:** accepted
- **Date:** 2026-06-22
- **Design:** docs/design/lfs-filter-driver-port.md · **Refines:** ADR-226 (git-faithfulness), ADR-249 (structured-data-only), ADR-398 (lifts its no-active-driver boundary) · **Relates:** ADR-302/303/304 (attribute model, driver resolution, CommandRunner / merge-driver)
- **Decision class:** user-ratified

## Context

ADR-398 pinned tsgit's no-active-driver baseline (diff the committed bytes as text) and
explicitly deferred the active-driver case for lack of a filter port. git has **two
independent** attribute mechanisms (pinned independent in the design's T5/F5): `diff=<name>`
→ `[diff].textconv` (read-side, diff-only, applied to both sides at diff time) and
`filter=<name>` → `[filter].clean`/`.smudge` (write-side: clean at add, smudge at checkout).
git-lfs configures both on the same path. The brief named active-driver **diff**
faithfulness; the designer recommended a minimal textconv-only v1 with clean/smudge deferred.

## Options considered

1. **textconv-diff only** (designer's recommendation) — one chokepoint (`materialise-patch-files`), no worktree-write path; clean/smudge deferred to a follow-up.
2. **All three surfaces** (textconv + clean/smudge) — the complete active-driver story.
3. **clean/smudge only** — leaves the brief's diff gap open.

## Decision

**v1 covers all three surfaces.** textconv transforms both sides at diff time (patch +
numstat only; `--raw`/`index` OIDs stay raw — ADR-249-clean); clean runs at add/stage
(worktree → blob), smudge at checkout (blob → worktree); `git diff` re-applies clean to the
worktree side (pinned F1). clean/smudge **reproduces git's `required` failure semantics
exactly** (pinned F3/F4: `required=true`+fail → fatal refuse / exit 128; absent-or-false+fail
→ warn, store raw bytes, exit 0 — git-lfs sets `required=true`). textconv and filter are
independent: a path may carry either, both, or neither.

## Consequences

- Three chokepoints in scope: `materialise-patch-files` (textconv, both sides), the add/stage
  path (clean), the checkout path (smudge) — the latter using the existing `streamBlob` for
  large smudged content.
- The `required`-failure semantics and the worktree-diff clean re-application are in v1, not a
  follow-up; no diff/checkout/add active-driver gap is left open.
- Larger, riskier v1 than the minimal textconv-only slice — accepted by the user for a
  complete active-driver story in one feature.
- `cachetextconv` remains out of scope (an observationally-transparent optimization — design
  D-CACHE); the `.process` long-running filter protocol is out of scope (design §6).
