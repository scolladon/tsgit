---
subjects:
  - docs/BACKLOG.md
  - src/application/primitives/internal/commit-graph-chain.ts
phases: [design]
kind: trap
trigger: a backlog entry names a function or file as the defect's locus and the run is about to design a fix for it
evidence:
  - docs/design/commit-graph-chain-strict-parse.md
  - test/integration/commit-graph-read-interop.test.ts
  - test/integration/fsck-commit-graph-interop.test.ts
source: { run: commit-graph-chain-strict-parse, phase: design, date: 2026-11-10 }
status: active
supersedes: []
last-verified: 2026-11-10
---
# 033 — A backlog entry naming a symbol is re-pinned on main before any design

## Context

Backlog 32.13 said `parseChainLayerHashes` skipped a blank line in `commit-graph-chain` and
loaded every layer, where git warned and refused. The entry was filed by the same commit that
deleted that function and replaced it with a line-by-line loader that already stops at the
first bad line, as git does. The run's brief asked for a design with two decision points. A
probe of the whole malformed-line family against git 2.56.0 and tsgit's own interop harness
showed every row already matching. The entry's description of git was also wrong: git serves
the layers loaded before the bad line, it does not drop the whole chain. The design shrank to
a probe table, and the change to regression rows.

## Lesson

A backlog entry records one moment. Later commits, including the one that filed it, can fix
the defect or remove the code it names, and the entry's account of git can be wrong too.
Designing from the entry gives a fix for a defect that no longer exists. A probe of the
current main against the oracle tells you the work the run actually owes.

## How to apply

Before design, grep `src` for the named symbol; `git log -S <symbol> -- src` dates its removal against the entry's filing.
Re-pin the entry's whole family on main, against git and against tsgit, before trusting either side of its claim.
Temporary probe rows in the existing interop suite are the cheapest tsgit-side probe: they reuse its fixtures.
When every row already matches, ship regression rows plus a red check that re-introduces the old behaviour.
Record the corrected git behaviour in the design doc, because the backlog tick only flips the box.

## Evidence

`docs/design/commit-graph-chain-strict-parse.md` holds the git 2.56.0 table and the finding that tsgit already matched it.
The interop suites `test/integration/commit-graph-read-interop.test.ts` and `test/integration/fsck-commit-graph-interop.test.ts` carry the rows. A loader that skips blank lines turns six of them red.
