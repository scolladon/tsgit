---
subjects:
  - package.json
  - .claude/workflow.md
---
# 796 — `check:deps` excepts `@cloudflare/workers-types`

- **Status:** accepted
- **Date:** 2026-09-04
- **Design:** docs/design/fix-main-ci-bench-fixture-deps.md (D6) · **Supersedes/Refines:** none

## Context

`@cloudflare/workers-types` publishes a date-versioned release every day. The `deps` CI job
runs `npm outdated` through a `grep -v` exception chain; the package's exception existed until
the v4 to v5 migration removed it, and the job has re-reddened on most days since. Bumping it
keeps the job green for exactly one day. Dependabot opens a weekly bump for it; the two prior
bump pull requests were closed unmerged.

## Options considered

1. **Add the `grep -v` exception and record the rationale in the manifest** (designer's
   recommendation) — pros: the same treadmill rationale the other six exceptions encode;
   Dependabot's weekly pull request still keeps the pin from rotting / cons: `npm outdated`
   no longer surfaces it at the pre-PR gate.
2. **Exception plus a Dependabot `ignore` and a manual cadence** — cons: removes the one
   mechanism that keeps the pin fresh, in exchange for nothing the exception does not already give.
3. **No exception; pin and bump on a cadence** — cons: red CI on every day the cadence is
   missed, which is the status quo that opened this change.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** The chain gains
`grep -v "^@cloudflare/workers-types "` (trailing space load-bearing) after the
`@vitest/coverage-v8` link, and the manifest's pre-PR-gate bullet records why in the voice of
the existing exceptions. A `workers-types` change that matters surfaces as a type error in the
Workers parity suite, not as an `npm outdated` row.

## Consequences

- The `deps` job stops reading the calendar.
- Dependabot keeps bumping the pin weekly; those pull requests merge as ordinary chores.
