# ADR-100: Mutation budgets partition by 4-bucket architecture tier

## Status

Accepted (at `90ea27b`)

## Context

Stryker's single-threshold model (`stryker.config.json` has `high:100 / low:95 / break:90`) treats every src file the same — `src/domain/objects/blob.ts` (pure binary parser, no platform dep) and `src/adapters/node/node-file-system.ts` (errno-conditional FS wrapper) gate on the same number.

The two are not the same. Pure domain logic has no platform escape hatch; bugs there are bugs in git's data model and must be caught by unit + mutation alone. Adapter code's correctness is the union of mutation signal AND the `posix-integration` / `win-integration` real-OS jobs — errno-conditional branches (`ELOOP`, `EISDIR`, 8.3 path reconciliation) cannot be mutation-tested because the unit suite stubs the FS at the `FsOperations` boundary.

Phase 19.1 introduces per-bucket budgets to fix this. The first question: how many buckets, and where do the lines go?

Options considered:

1. **7-bucket cut on architecture sub-tiers** — `domain/`, `application/primitives/`, `application/commands/`, `adapters/`, `operators/`, `transport/`, `ports/`. Maps the dependency rule (`repository → commands → primitives → domain`) directly. Higher fidelity, more authoring overhead, more nuance for budget calibration.
2. **4-bucket cut on architecture tiers** — `domain/`, `application/`, `adapters/`, `infra/` (operators + transport + ports). Matches the four-arrow narrative the project uses everywhere: `repository → application → adapters → infra (ports)`.
3. **2-bucket cut on platform-dep boundary** — `pure/` vs `effectful/`. Simplest, but throws away the application/adapter distinction that actually drives budget calibration.

## Decision

Use the 4-bucket partition.

| Bucket | Globs | Rationale anchor |
|---|---|---|
| `domain` | `src/domain/**` | Pure value objects, parsers, binary encoders, ref/index/pack readers, merge/diff engines, hooks runner, glob matcher. No platform deps. |
| `application` | `src/application/**`, `src/repository.ts`, `src/repository/**`, `src/dispose-adapters.ts` | Tier-1 commands, tier-2 primitives, `openRepository` facade. Composition of pure primitives with effectful ports. |
| `adapters` | `src/adapters/node/**`, `src/adapters/memory/**`, `src/adapter-detect.ts` | Platform glue (Node + memory). Browser adapter excluded from mutation entirely (unchanged from prior config). |
| `infra` | `src/operators/**`, `src/transport/**`, `src/ports/**`, `src/progress.ts` | AsyncIterable operators, transport middleware (retry/auth/logging), port interfaces, progress reporter. |

Buckets are authored disjoint. The runtime budget-check script asserts disjointness (no file matches more than one bucket) and exhaustiveness (no file under `mutate` matches zero buckets) on every run. A new src/ folder added without a bucket update fails the script.

Numeric thresholds per bucket are NOT decided here — see [ADR-101](101-mutation-budgets-per-bucket.md). This ADR is the partition shape only; the numbers are separable because they will be re-calibrated as we learn from PR data, but the bucket lines themselves are load-bearing and stable.

## Consequences

### Positive

- Bucket names appear directly in the budget table the gate prints, in PR check output, in CONTRIBUTING. The vocabulary stays close to the architecture vocabulary the project already uses.
- Four buckets is a number a reviewer can hold in their head; seven is not.
- The script's "every src file maps to exactly one bucket" assertion means a new folder added during refactoring can't silently drop out of the gate.

### Negative

- Coarser than the architecture's actual sub-tiers. A future need to differentiate `application/primitives/` (lower-level, deserves stricter budget) from `application/commands/` (higher-level, more defensive guards) requires a manifest-level split — non-breaking but real work.
- `infra` bundles three sub-areas (operators / transport / ports) with arguably different test-quality profiles. Operators are pure; transport middleware has retry timers and abort plumbing. Lumped together for now; can split later if data argues for it.

### Neutral

- Buckets are configuration (`mutation-budgets.json`), not code. Re-partitioning is a manifest edit + script re-run, not a refactor.
- The partition does not affect how Stryker itself runs — it remains a single-process run; bucketing is post-process aggregation on the JSON report.

## Alternatives considered

- **7-bucket cut** — rejected: noise > signal at this scale of codebase. We don't have enough mutation data per file to calibrate seven independent thresholds, and the application primitives/commands distinction is fluid enough that the line would drift.
- **2-bucket pure/effectful** — rejected: collapses the application/adapter distinction, which is the very distinction that drives the budget gap (95 vs 85). The whole point of per-domain budgets is to acknowledge that adapters get real-OS coverage outside mutation.
- **Per-file overrides** — rejected: introduces an ungrokable matrix of file × threshold; every reviewer has to chase override files to know the bar. Buckets are the principled aggregation.
