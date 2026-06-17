# 356 — Guard-then-sweep: retire the redundant interop config pins behind a centralized env tripwire

- **Status:** accepted
- **Date:** 2026-06-17
- **Design:** [design/retire-redundant-config-pins.md](../design/retire-redundant-config-pins.md) · **Refines:** [ADR-339](339-interop-sweep-drop-redundant-isolation-duplication.md)

## Context

[ADR-339](339-interop-sweep-drop-redundant-isolation-duplication.md) hardened `interop-helpers.ts` (scrubbed `GIT_*`, non-existent `HOME`, `GIT_CONFIG_NOSYSTEM=1`, redirected `XDG_CONFIG_HOME`) and, judging a corpus-wide pin removal premature, **retained** the ~25 `commit.gpgsign=false` and 5 `-c merge.conflictStyle=merge` per-test pins as "self-documenting safety nets against a future weakening of the helper", deferring their retirement to a separate backlog entry. That entry is 24.9t. The precondition has since changed: 24.9o also landed `interop-env-hardening.test.ts`, a centralized tripwire that pins the helper's config-discovery isolation (`HOME`/system/`XDG`) — but **not** the `GIT_*`-scrub half of the contract. So the decision is no longer "remove the safety nets or not"; it is whether closing that one tripwire gap makes the scattered nets redundant enough to retire, and how to record reversing an explicit retention.

## Options considered

1. **(chosen) New ADR recording guard-then-sweep** — close the `GIT_*`-scrub tripwire gap first, then retire the pins; record *why* the retirement is now safe where ADR-339 judged it premature. Pros: appends to history, names the new safeguard that licenses the reversal; cons: one more ADR for a test-only change.
2. **Reference ADR-339 only** — treat 24.9t as merely executing ADR-339's deferred Option 3. Pros: lightest; cons: understates that ADR-339 kept the pins *on purpose* — the centralized guard, not the mere passage of time, is what makes removal safe.
3. **Amend/supersede ADR-339 in place** — flip its retention decision. Pros: one ADR; cons: rewrites accepted history, against the append-only ADR convention.

## Decision

Retire the redundant pins **only behind a centralized guard**, in this order:

1. **Guard first (TDD).** Extend `test/integration/interop-env-hardening.test.ts` with an **env-object** assertion on `runGitEnv()`: the spawn env carries no `GIT_*` key except the two the helper deliberately re-adds (`GIT_CONFIG_NOSYSTEM`, `GIT_CEILING_DIRECTORIES`), and `GIT_CEILING_DIRECTORIES === os.tmpdir()`. This closes the `GIT_*`-scrub gap so the full env-isolation contract (config-discovery half + scrub half) fails loudly in one place if any key is dropped. Env-object over behavioural: a behavioural probe cannot distinguish "scrubbed" from "no `GIT_*` was set in this process" and false-greens on a clean runner.
2. **Then sweep.** Remove every `commit.gpgsign=false` pin (both forms — per-invocation `-c` and per-repo `git config` write) and every `-c merge.conflictStyle=merge` pin, carrying each pin's now-stale hazard comment with it. The removals are licensed by the empirical pin in the design (under the helper env, ambient `diff3`/`gpgsign=true` do not leak; git falls to 2-way `merge` style and unsigned commits), so each pin is provably inert.
3. **Retain `config-interop`'s `--local`/`--file`.** It is genuine read-scoping and stack-parse-mask avoidance, a different mechanism from the value pins — not redundant isolation.

The eventual squash is typed **`test:`** (the diff is wholly under `test/`).

## Consequences

### Positive

- The protection against a future helper weakening moves from ~30 scattered, easily-deleted pins into one intentional tripwire; a regression now trips `interop-env-hardening.test.ts` under `npm run validate` rather than silently re-exposing 30 suites.
- The corpus loses redundant overrides; the diff is removed pins + one extended guard, no `src/` change, no golden/SHA/ref/reflog/state byte change.

### Negative

- One more ADR and a guard test for a test-only tidy. Accepted: ADR-339 retained the pins as a deliberate decision, so reversing it warrants its own record.

### Neutral

- Stryker mutates `src/**` against `test/unit` only, so neither the helper nor the new guard is mutated; the guard's value is as a `validate`-gate tripwire, not a mutation-score contribution.
- `config-interop`'s `--local`/`--file` and `initBothRepos`'s identity setup writes are out of scope (load-bearing, not isolation workarounds).
