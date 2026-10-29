---
subjects:
  - src/application/primitives/internal/object-emit.ts
  - src/application/primitives/internal/closure-engine.ts
  - src/application/primitives/internal/peel.ts
  - test/integration/alternates-gc-fsck-interop.test.ts
phases: [design, planning, implementation]
kind: technique
trigger: a plan row marked GUARD over a git-pinned behaviour fails on its first run
evidence:
  - docs/design/gc-size-lying-loose-blob.md
  - test/integration/alternates-gc-fsck-interop.test.ts
  - src/application/primitives/internal/object-emit.ts
source: { run: gc-size-lying-loose-blob, phase: implementation, date: 2026-10-21 }
status: active
supersedes: []
last-verified: 2026-10-29
---
# 005 — A pinned row the design expects to pass is a probe, not a GUARD

## Context

The design pinned git's exit 0 for a size-lying loose blob that only an alternate holds and
stated that tsgit already matched it; the plan listed the interop row as a GUARD. The row went
red in implementation: the closure typed every want, index entries included, by reading its
whole body, so the liar refused at root resolution. A second, deeper variant of the same gap
(the blob named by a ref, reached through the commit-graph tail) surfaced only in review. Each
cost a plan amendment, an inserted part and a review cycle.

## Lesson

A matrix row the design says tsgit "already" satisfies is a claim about tsgit, and it needs the
same evidence as a claim about git: a run on the fixture. A GUARD in a plan inherits that
claim. When the designer pins git on a mktemp fixture, running tsgit on the same fixture costs
one more command and turns the GUARD into either a proven pass or a RED with a known cause,
before planning sizes the parts.

## How to apply

Probe tsgit on every design row that claims tsgit already matches git, with the same fixture used to pin git.
Treat a plan GUARD over such a row as a claim that needs that probe's output quoted in the part's Context.
When a GUARD goes red, stop the part; find the read site with a probe, not by reading code; fix it as its own part.
Re-check the neighbouring variants of the fixed row (index entry, ref target, tag target) before closing the part.

## Evidence

`docs/design/gc-size-lying-loose-blob.md` — rows G8 and G11 and change-set row P6.
`test/integration/alternates-gc-fsck-interop.test.ts` — the donor-only liar rows, by index and by ref.
`src/application/primitives/internal/object-emit.ts` — `isBlobByHeader` and the typed `PeeledWant`.
