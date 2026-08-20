# 698 — The assert-tier guard is a verb-granular audit script

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/repository-format-acceptance-gate.md (candidate DN-3) · **Refines:** ADR-682

## Context

ADR-682 requires a mechanical guard: no module may call bare `assertRepository` unless it is on
an explicit allowlist of exactly four verbs (`configGet`, `configGetAll`, `configGetRegexp`,
`configList`). Without it, option (b)'s three-tier split fails open — a future command reaching
for the most natural name would silently operate on a rejected repository.

The obvious home does not fit. The repo's architecture-tier check (`check:architecture`,
dependency-cruiser) is **module**-granular, while the requirement is **verb**-granular: the four
survivors share `src/application/commands/config.ts` with the five writers that must refuse. The
two cannot both be satisfied without moving source.

## Options considered

1. **A verb-granular audit script** — `tooling/audit-assert-tier.ts` plus an allowlist JSON, wired
   into `validate` as `check:assert-tier`, using the TypeScript compiler API — pros: exact
   granularity; follows the established `tooling/dts-value-exports.ts` /
   `tooling/truthful-dts.ts` precedent; a first-class gate in `validate` / cons: one more
   tooling script to maintain.
2. **A verb-granular source-scanning test** — pros: no new wireit target / cons: it lands a
   shipping-safety precondition in the test tier, where a scoped-down or filtered run silently
   disarms it. A guard that can be skipped is not a guard.
3. **A module-granular dependency-cruiser rule** — split bare `assertRepository` into its own
   module and barrel-ise `commands/config.ts` into internal read/write modules — pros: the most
   architecturally honest / cons: splits a published subpath (`./commands/config`) and still
   drops to module granularity, so a fifth verb added to the read module slips through — it does
   not actually deliver the guarantee.

## Decision

**Option 1 — adopted as recommended (no user judgment).**

`tooling/audit-assert-tier.ts` walks the source with the TypeScript compiler API, finds every
call to bare `assertRepository`, and fails unless the enclosing exported verb appears in
`tooling/audit-assert-tier.allowlist.json`. It runs as `check:assert-tier` inside
`npm run validate`.

Adding a fifth surviving verb therefore requires editing a committed allowlist — a small,
reviewable, greppable act, which is exactly the property ADR-682 asks for.

## Consequences

- The guard is a build gate, not a test, so it cannot be disarmed by a scoped test run.
- Two known tooling traps apply and are part of the implementation: Biome's `files.includes` is
  an **allowlist**, so a new `tooling/*.ts` file is silently unlinted until it is added; and any
  tooling script that imports from `src` must build and import from `dist`. This script parses
  source with the compiler API rather than importing it, which avoids the second trap.
- The failure message must name the offending verb, its file and line, and the allowlist path —
  a future author hitting it should not have to read this ADR to know what to do.
- Option 3's honest core survives as a possible later refactor: if `commands/config.ts` is ever
  split for independent reasons, the dependency-cruiser rule becomes available as a second,
  coarser layer. It is not a substitute for this one.
