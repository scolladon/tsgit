---
subjects:
  - src/application/primitives/internal/repo-state.ts
  - src/application/commands/checkout.ts
---
# 1284 — checkout validates `checkout.guess` by config line order

- **Status:** accepted
- **Date:** 2026-11-27
- **Design:** docs/design/checkout-remote-branch-dwim.md (DC-4) · **Supersedes/Refines:** applies ADR-226

## Context

git's `git_checkout_config` parses every `checkout.guess` entry with `git_config_bool` while the
config is read, in file order, and chains to `git_default_config`. A bad value refuses every
checkout, path restores included, and between it and the eager keys (`branch.autoSetupMerge`,
`core.*`) the entry on the lower line is the one refused (rows O1, O2, R24b–R24e, C1).

## Options considered

1. **Merge the command key into the eager race:** the lowest line wins, through an
   `assertOperationalRepository` variant that takes command keys (recommended).
2. Validate `checkout.guess` after the eager gate.
3. Validate it before the gate.

## Decision

**Adopted-as-recommended (no user judgment)** — ADR-226: O1 and O2 are pinned, and ADR-1170 does
not relax faithfulness for new work. Option 2 leaves O1 red. Option 3 refuses ahead of the
setup refusals git raises first. The `guess` option (ADR-1281) does not skip the check.

## Consequences

### Positive

- The refusal named matches git for any mix of bad keys.

### Negative

- The memoized gate verdict exposes the winning entry's line instead of only throwing.
