# ADR-101: Per-bucket mutation thresholds (high / low / break)

## Status

Accepted (at `90ea27b`)

## Context

[ADR-100](100-mutation-pyramid-bucket-partitioning.md) splits `src/` into four buckets: `domain`, `application`, `adapters`, `infra`. This ADR decides the numbers.

Stryker's threshold model has three rungs: `high` (green), `low` (warn), `break` (fail). The project's pre-19.1 global thresholds were `high:100 / low:95 / break:90` — a single set applied to the union of all mutated files.

Per-bucket, the question is: at what bar should each bucket fail a PR?

Two competing pressures:

- **Too strict and the gate becomes noise.** If `adapters` breaks at 99 and the adapter has errno-conditional branches that unit tests fundamentally cannot reach (real ELOOP only happens against a real symlink loop), every adapter PR needs a `// equivalent-mutant:` annotation just to land. The annotations stop being signal and become friction.
- **Too loose and the gate is meaningless.** If `domain` breaks at 90, a PR that introduces a parser regression covered by a single happy-path test passes. The whole reason for the pyramid is that domain code's bar is higher than adapter code's bar.

## Decision

| Bucket | high | low | break | Rationale |
|---|---|---|---|---|
| `domain` | 100 | 100 | 99 | Pure logic, no platform escape hatch. 99% break leaves room for ~1 provably-equivalent mutant per ~100 mutants without forcing an inline `// equivalent-mutant:` annotation on a freshly-touched file. |
| `application` | 100 | 98 | 95 | Composition of primitives with effectful ports. Some branches are defensive guards that integration tests cover (e.g. lock-acquisition retries). 95% break absorbs that without rewarding sloppy unit tests. |
| `adapters` | 95 | 90 | 85 | Platform branches exercised in `posix-integration` and `win-integration` real-fs jobs; mutation cannot cover errno-conditional code paths because the unit suite stubs the FS via `FsOperations` DI. 85% break accepts the structural gap. |
| `infra` | 100 | 95 | 90 | Operators are pure (target 100); transport middleware has retry timers and abort plumbing where mutation flakes. 90% break leaves headroom for the timing-sensitive transport code without softening the operator bar. |

Score formula: Stryker's `mutationScore` (the project's existing global gate's formula):

```
score = killed / (killed + survived + timeout + noCoverage) * 100
```

`noCoverage` counts as not-killed — uncovered code surfaced by a mutant is a real test-quality gap, and the gate alignment matches the project's "kill every killable mutant" stance.

These thresholds apply to **the set of files mutated in the run**. On the PR gate, the run is diff-scoped, so a PR touching one adapter file enforces `adapters ≥ 85` on that one file only; buckets with no mutated files are reported `n/a` and do not gate.

## Consequences

### Positive

- Each bucket's bar reflects what unit + mutation testing can actually achieve there. Authors don't have to game `// equivalent-mutant:` annotations to land adapter PRs.
- The `domain` bucket's 99% break is high enough to force real care on pure-logic edits — the place where bugs are most likely to be silent and lasting.
- The visible spread (99 / 95 / 85 / 90) tells contributors at a glance: domain matters most, adapters get integration help.

### Negative

- The numbers are calibration-by-judgment, not by data. We do not yet have a baseline distribution of per-bucket mutation scores on `main`. If the actual `domain` score on `main` is 97, then 99 break is too strict and every domain PR fails; we'd discover this on the first PR and lower the number. Mitigated by: thresholds are JSON config, not code — re-calibration is a one-line change.
- The 10-point gap between `adapters` (85) and `application` (95) creates a refactoring incentive to push code into the `adapters` bucket to game the bar. The disjointness check (every file maps to exactly one bucket) and code review are the guardrails.

### Neutral

- `low` and `high` thresholds are advisory only (Stryker prints colored output). The `break` is what gates CI.
- The pre-19.1 global thresholds in `stryker.config.json` (`high:100 / low:95 / break:90`) stay as the fallback for invocations that don't go through the bucket script (local `npm run test:mutation` for ad-hoc full-tree exploration).

## Alternatives considered

- **One uniform per-bucket bar (e.g. break:95 across all four)** — rejected: defeats the whole point of bucketing. The signal a uniform bar produces is the same signal the pre-19.1 single global threshold produces.
- **break:100 on domain** — rejected: forces inline `// equivalent-mutant:` annotations on the first provably-equivalent mutant a fresh-domain edit encounters, even when the mutant is genuinely equivalent. Friction without quality return.
- **Trailing-window calibration (set break = main-branch score - 1%)** — rejected: introduces a moving target; a single bad PR slipping in could quietly lower the bar for all subsequent PRs. Static numbers are auditable.
- **break:90 on adapters** — rejected: the data we have (16 existing `// equivalent-mutant:` annotations, ~half in adapters) suggests 90 is reachable but tight; 85 gives one PR of headroom without flapping.
