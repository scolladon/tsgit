# 677 — No deny-by-default trust mode; the uid comparison is proven in the unit tier

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/ownership-trust-gate.md (candidate D9)

## Context

The interop suite cannot manufacture an alien-owned repository on **both** sides. git's side can
be forced with `GIT_TEST_ASSUME_DIFFERENT_OWNER` (verified present and effective in 2.55.0);
tsgit's cannot. Measured on this machine: `chown` to another uid fails with
`Operation not permitted`, `sudo -n` requires a password, and no reachable repository owned by
another uid exists — every `.git` under `/opt/homebrew`, including taps and casks, is owned by
the caller.

## Options considered

1. **Real `chown` when the environment permits, `describe.skipIf` otherwise**; use
   `GIT_TEST_ASSUME_DIFFERENT_OWNER` only to pin git's message and exit-code goldens — pros: no
   production surface added for a test's benefit / cons: the co-refusal rows never run locally,
   and run in CI only if the job happens to have root.
2. **Ship `trust: 'allowlist'`** — a public deny-by-default mode letting both sides be forced
   untrusted, making the whole matching matrix always-on (design recommendation) — pros: an
   always-on, non-vacuous co-refusal against real git / cons: adds a public API mode whose
   immediate motivation is testability.
3. **An internal capability-injection seam** on the node shim, used only by tests — a test seam
   in production code with none of option 2's user-facing value.

## Decision

**Option 1 — ratified by the user, against the design's recommendation.**

No third `trust` mode ships. The interop co-refusal rows are gated on a **concrete, stated**
skip predicate — never a silently vacuous test — and `GIT_TEST_ASSUME_DIFFERENT_OWNER` is used
to pin git's exact refusal bytes and exit codes regardless, since that half needs no tsgit-side
alien owner.

The full ownership truth table lands in the **unit tier** through the `isOwnedByCaller`
capability stub of ADR-669: owned / alien × allowlisted / not / `*` / trailing-slash × bare /
non-bare × capability-omitted. Because the predicate is a port capability, it stubs cleanly, and
that is where the semantics are proven.

## Consequences

- The uid comparison itself — the one thing a stub cannot prove — is exercised only where the
  environment can produce a real alien owner. This residual is accepted and stated here rather
  than hidden behind a green suite.
- The public trust surface stays exactly what a user needs (ADR-671, ADR-675), with nothing
  added for the test harness.
- ADR-675's `bareRepositories` rows remain the fully-proven interop anchor, since they need no
  alien owner at all.
