---
subjects:
  - src/application/primitives/internal/clear-skip-worktree-from-present-files.ts
  - test/bench/status-sparse.bench.ts
phases: [decisions, implementation]
kind: gotcha
trigger: a design gates a fold's cost as a percentage over a base that does not do the work git does
evidence:
  - docs/adr/1247-the-bit-clear-probes-presence-synchronously-under-a-floor-relative-gate.md
  - test/bench/status-sparse.bench.ts
  - test/bench/status-racy-window.bench.ts
source: { run: skip-worktree-present-files, phase: implementation, date: 2026-11-22 }
status: active
supersedes: []
last-verified: 2026-11-25
---
# 050 — A perf gate on newly faithful work is measured against git's floor

## Context

ADR-1243 gated the skip-worktree bit clear at 10% of `status` over main. Main performs no `lstat`;
git performs one per skip-worktree entry outside a known-missing directory. The gate fired at
+937% with the sequential walk and still at +12% on the removed-directories row once the walk
was synchronous: it measured git's own work, not an overhead. Both rows had to be re-ratified
against a floor of one bare synchronous `lstat` per probe git makes (ADR-1247).

## Lesson

A base that skips the work git does is no yardstick for a faithful fold's cost.

## How to apply

At design, count the syscalls git makes for the fold on the bench fixture.
Write the gate as overhead over that floor (bare calls plus one scan), not over main.
Measure the floor and the base on the same fixture before ratifying the gate.

## Evidence

`docs/adr/1247-the-bit-clear-probes-presence-synchronously-under-a-floor-relative-gate.md` —
Context and Decision; `test/bench/status-sparse.bench.ts` — the floor and the two status rows.

Refreshed 2026-11-25: `docs/adr/1267-the-racy-window-status-bench-gates-against-a-floor-twin.md` —
the design gated the racy-window `status` at 1.25 over reading the index and hashing every file;
it measured 1.36 to 1.60, because that base leaves out the scan git also pays. The ratified gate
is 1.5 over a settled `status` plus one read and one SHA-1 per file, in
`test/bench/status-racy-window.bench.ts` (1.07, 1.13, 1.09).
