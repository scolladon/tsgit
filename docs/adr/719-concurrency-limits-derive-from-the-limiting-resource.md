---
subjects:
  - src/domain/concurrency/derive-limits.ts
  - src/ports/context.ts
  - src/adapters/node/node-concurrency.ts
  - src/index.node.ts
  - src/index.browser.ts
  - src/index.default.ts
---
# 719 — Concurrency limits derive from the limiting resource

- **Status:** accepted
- **Date:** 2026-08-26
- **Design:** docs/design/perf-remediation-2026-08.md (DC-5…DC-8) · **Supersedes/Refines:** none

## Context

Twelve pool sites carry hand-picked constants and three hot loops are unbounded or
sequential; none derives from a machine property. On Node, async zlib/crypto/fs all
queue on the libuv threadpool (default width 4), so a CPU pool wider than the pool adds
latency, not throughput, while a blocked-I/O pool profits from oversubscription. The
user requirement: every bound derives from its limiting resource, never a magic constant.

## Options considered

1. **Composite** (recommended, chosen): pure domain selector `deriveLimits({cores?, threadpoolWidth?}) → {cpuBound, ioBound}`; resolved limits ride an optional `Context.concurrency`; internal type, public override via `RepositoryConfig.parallelism` widened to `number | { cpu?, io? }`.
2. **Same, with the limits type exported publicly** — cons: widens `reports/api.json` for a two-integer shape we want free to change.
3. **Five named stages with per-stage multipliers** — cons: the multipliers would be invented, not measured — the exact failure mode the requirement forbids.

## Decision

**User-ratified composite.**

- `cpuBound = clamp(1, min(cores, threadpoolWidth), CPU_CAP)` — never oversubscribed.
- `ioBound = clamp(1, threadpoolWidth × IO_OVERSUBSCRIBE, IO_CAP)` — oversubscribed
  deliberately; the cap bounds file-descriptor pressure.
- The selector is a pure, total domain function; platform facts are read only at the
  composition roots: node shim reads `os.availableParallelism()` and
  `UV_THREADPOOL_SIZE` (default 4); browser shim reads
  `navigator.hardwareConcurrency ?? 4`; the default entry passes nothing and takes the
  safe floor (`cpu 1 / io 4`) — workerd always takes the floor. The floor is a safe
  answer, never a fast one.
- The resolved limits ride `Context.concurrency` (optional — absent means floor).
- `ConcurrencyLimits` stays internal; the caller override is
  `RepositoryConfig.parallelism: number | { cpu?: number; io?: number }`, and an explicit
  caller value always beats the derived one. Existing `parallelism` numbers keep working
  and now govern every pool, not two — a deliberate widening.
- tsgit never sets `UV_THREADPOOL_SIZE`; integrator documentation states that raising it
  must happen in the host application before first threadpool use. Non-Node runtimes that
  accept but may not honour the variable are treated as "threadpool width unknown" → floor.

## Consequences

Every pool introduced or re-pointed resolves its bound through this seam, and the
derivation matrix (1/2/11/128 cores × threadpool unset/1/4/64, and no-facts) is unit-proved.
Bound values change on real machines (e.g. object-load 32 → derived), so each re-pointed
pool is A/B-measured, not assumed neutral. The dead `JoinOptions.concurrency` option is
wired or removed in the implementing change.
