---
subjects:
  - src/application/commands/checkout.ts
---
# 1281 — checkout takes a `guess` option for the remote-branch guess

- **Status:** accepted
- **Date:** 2026-11-27
- **Design:** docs/design/checkout-remote-branch-dwim.md (DC-1) · **Supersedes/Refines:** none

## Context

When no revision answers `checkout <name>`, git guesses a local branch from the one remote that
tracks `refs/heads/<name>` (`checkout.guess`, default true). `--no-guess` turns the guess off for
one call, and `--guess` turns it on over `checkout.guess=false` (rows R5, R5b, git 2.56.1).
tsgit has no per-call counterpart.

## Options considered

1. **`guess?: boolean` on `CheckoutSwitchOptions`**: `false` is `--no-guess`, `true` overrides
   `checkout.guess=false`, omitted reads the config (recommended).
2. No option: callers write `checkout.guess` to opt out.
3. `noGuess?: true`, styled like `createBranch.noTrack`.

## Decision

**Ratified by the user** — option 1. It is the only shape that expresses both R5 and R5b.
Option 2 forces a config write to say `--no-guess` and cannot say `--guess`. Option 3 cannot
express R5b.

The option does not skip the validation of `checkout.guess` (ADR-1284): git parses the key
before it reads the command line (R24d).

## Consequences

### Positive

- Every pinned guess row is expressible per call.

### Negative

- One more optional member on `CheckoutSwitchOptions` (classified by ADR-1287).
