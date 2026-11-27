---
subjects:
  - src/domain/commands/error.ts
  - src/application/commands/checkout.ts
---
# 1283 — checkout refuses the guess and detach-argument cases with their own codes

- **Status:** accepted
- **Date:** 2026-11-27
- **Design:** docs/design/checkout-remote-branch-dwim.md (DC-3) · **Supersedes/Refines:** applies ADR-249

## Context

The guess path has three refusals git words around an argument (git 2.56.1, exit 128):
`'<name>' matched multiple (<n>) remote tracking branches` with the matching remotes in its
advice (S11), `'<name>' could be both a local file and a tracking branch.` (S10), and
`git checkout: --detach does not take a path argument '<arg>'` (S12, ledger row 32.1 A22). A
guessed branch with `--detach` prints the `-b` refusal word for word (R9c).

## Options considered

1. **New codes:** `CHECKOUT_REMOTE_BRANCH_AMBIGUOUS { name, remotes }`,
   `CHECKOUT_PATH_OR_TRACKING_BRANCH { name }`, `CHECKOUT_DETACH_PATH_ARGUMENT { argument }`;
   R9c reuses `INVALID_OPTION { option: 'createBranch', reason: 'cannot be combined with detach' }`
   (recommended).
2. As 1, with R9c on `INVALID_OPTION { option: 'detach' }`.
3. `INVALID_OPTION` with the argument in `reason` for all three, `TRACKING_AMBIGUOUS` for S11.

## Decision

**Adopted-as-recommended (no user judgment)** — option 1, on the precedent of ADR-1196 and
ADR-1199, which added codes to existing calls as fixes. Each code carries the argument as data.
`TRACKING_AMBIGUOUS` is git's other refusal (`not tracking: ambiguous information`, R17), so
option 3 would merge two conditions. Option 2 splits one git message across two codes.
`remotes` lists the matching remotes in config order, as git's advice does.

## Consequences

### Positive

- Every new refusal is told apart by code, and git's message can be rebuilt from its fields.

### Negative

- Three more members in the error-data union.
