# 419 — archive gates on assertRepository only

- **Status:** accepted
- **Date:** 2026-06-26
- **Design:** docs/design/archive.md · **Relates:** ADR-226 (git-faithfulness), ADR-346 (assertOperationalRepository gate)
- **Decision class:** D-GATE adopted-as-recommended (no user judgment)

## Context

Which assertion guards `archive`? Some read commands gate on
`assertOperationalRepository` (HEAD exists **and** core config is valid). `git archive`,
however, refuses only when invoked **outside a repository**; an unborn HEAD or an
unresolvable rev surfaces as a rev-vocabulary error (`fatal: not valid object name`), and
a blob tree-ish surfaces as `fatal: not tree object` — all from resolution, not from a
state gate.

## Options considered

1. **`assertRepository` only** (a repository / gitdir resolves) *(designer recommendation)*
   — pros: faithful — git's sole non-rev refusal is non-repository; rev resolution
   surfaces unborn-HEAD and unresolvable-rev errors itself; cons: slightly less consistent
   with the operational-gate read commands.
2. **`assertOperationalRepository`** (HEAD + valid core config) — pros: surface
   consistency with `log` et al.; cons: would refuse a repo on grounds git does not, and
   conflate the gate's refusal with rev resolution's.

## Decision

**Option 1 — adopted as the design recommended.** `archive` gates on `assertRepository`
only. The refusal matrix is then:

- **R1** non-repository → the gate's `notARepository`;
- **R2** unborn HEAD / **R3** unresolvable rev → the rev-vocabulary error from `revParse`;
- **R4** tree-ish resolves to a blob → `not tree object` from `peel` / classify.

This is the faithful split — one state gate, every other refusal from resolution, matching
the pinned matrix.

## Consequences

- `archive` runs wherever a repository resolves; it does not require a born HEAD or valid
  core config of its own.
- Each refusal is asserted on its structured `.data.code` (never `toThrow(Class)` alone)
  in the tests, the blob-refusal guard isolated.
