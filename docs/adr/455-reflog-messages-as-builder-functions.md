# 455 — Reflog messages as pure builder functions

- **Status:** accepted
- **Date:** 2026-07-05
- **Design:** docs/design/magic-literal-sweep.md · **Relates:** ADR-453, ADR-226
- **Decision class:** D-structure (ratified — user judgment; deviates from design recommendation)

## Context

Many reflog messages are templated: `cherry-pick: ${subject}`,
`branch: Created from ${startPoint}`, `fetch ${remote}: storing head`,
`reset: moving to ${oid}`, `commit (initial): ${subject}`. They are assembled inline at each
call site across `commit.ts`, `branch.ts`, `cherry-pick.ts`, `revert.ts`, `abort-merge.ts`,
`clone.ts`, `fetch.ts`. The design recommended extracting only the **static prefix** as a
constant and keeping interpolation at the call site (smallest diff).

## Options considered

1. **Static prefix constants** — e.g. `REFLOG_RESET_MOVING_TO = 'reset: moving to '`;
   interpolation stays at the call site. Smallest diff, lowest faithfulness risk. *(design
   recommendation)*
2. **Pure builder functions** — `domain/reflog/reflog-messages.ts` exports builders that own
   the whole line (`cherryPickReflog(subject)`, `resetMovingTo(oid)`, …). More encapsulation;
   interpolation logic moves into the reflog module.

## Decision

Option **2** — user judgment, overriding the design's static-prefix recommendation. The
reflog module owns each message's full assembly as a pure, side-effect-free builder. This
concentrates the canonical *format* (not just the prefix) in one place, so a faithfulness fix
to any reflog line is a single-function edit.

Per the scope-fold rule, the design doc is revised to reflect builders before planning.

## Consequences

- Each builder is a pure function and gets a **direct unit test with hardcoded expected
  strings** (the R4 independent-oracle rule from ADR-453 — the test does not import the
  builder's own literals as its expectation, it hardcodes the exact git-canonical string).
- Slightly larger conceptual change than static prefixes; the assembled bytes are unchanged,
  so faithfulness holds (ADR-226) and the reflog interop goldens remain green.
- Interpolation logic leaves the command call sites, which read as a single named call.
