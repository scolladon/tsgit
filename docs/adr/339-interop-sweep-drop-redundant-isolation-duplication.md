# ADR-339: Sweep scope — drop only the duplicated local isolation, retain explicit pins

## Status

Accepted

- **Date:** 2026-06-15
- **Design:** [design/interop-helper-env-hardening.md](../design/interop-helper-env-hardening.md)

## Context

Backlog 24.9o mandates a sweep of the interop suites for tests that silently depended on ambient git config. The sweep (design **Sweep findings**) found the corpus already disciplined: no suite relies on ambient config for a passing assertion. Hardening the helper ([ADR-337](337-interop-helper-home-isolation-non-existent-path.md), [ADR-338](338-interop-helper-xdg-config-home-inside-home.md)) therefore changes no suite's behaviour, but it does make several per-test workarounds redundant: ~25 suites pin `commit.gpgsign=false`, four pin `-c merge.conflictStyle=merge`, `config-interop` uses `--local`, and `missing-value-refusal-interop` hand-rolls its own per-test isolated `HOME` + `GIT_CONFIG_NOSYSTEM=1` over `runGitEnv()`. The question is which of these to remove now vs. leave.

## Options considered

1. **Leave every workaround** — purely additive hardening; the pins stay as live, correct, self-documenting belt-and-suspenders; cons: leaves `missing-value-refusal`'s local isolation as dead duplication of the helper's new guarantee.
2. **(chosen) Drop only the duplicated local isolation** — remove `missing-value-refusal`'s now-redundant `HOME`/`GIT_CONFIG_NOSYSTEM` re-creation (it duplicates the *same mechanism* the helper now owns), behaviour-preserving; leave the `gpgsign`/`conflictStyle`/`--local` pins (a *different* mechanism — explicit per-invocation overrides — that merely became redundant).
3. **Remove all redundant pins** — corpus-wide tidy of ~25 suites; cons: widest diff, would re-enter review as a behaviour-touching scope expansion, and exceeds 24.9o's logged scope — belongs in its own dependency-ordered backlog entry.

## Decision

The sweep removes **only** `missing-value-refusal-interop`'s local isolation duplication — the per-test `mkdtemp` `HOME` + `GIT_CONFIG_NOSYSTEM=1` it spread over `runGitEnv()` — because the hardened helper now guarantees exactly that isolation for every suite (no-dead-code: the local re-creation is duplication of the helper's own mechanism). The change stays behaviour-preserving: that suite's valueless-identity assertion still sees git read no ambient `user.*`, now via the helper's non-existent `HOME` instead of its own `mkdtemp`. The independent explicit pins (`commit.gpgsign=false`, `-c merge.conflictStyle=merge`, `config-interop`'s `--local`) are **retained** as correct, self-documenting safety nets. A corpus-wide retirement of those pins (Option 3) is explicitly out of scope and, if pursued, is logged as a separate backlog entry rather than folded here.

## Consequences

### Positive

- Closes 24.9o's sweep mandate while eliminating the one genuinely dead duplication; diff stays tight; no scope expansion or re-review triggered.
- The retained pins keep documenting the historical hazard at each call site and guard against a future weakening of the helper.

### Negative

- The corpus is briefly inconsistent (one suite's HOME/NOSYSTEM duplication removed, the unrelated `gpgsign`/`conflictStyle` pins kept) — but the distinction is principled: duplication of the helper's mechanism is removed; independent explicit overrides are not.

### Neutral

- A future corpus-wide cleanup of the redundant explicit pins remains available as its own backlog follow-up; it is neither blocked nor mandated by this decision.
