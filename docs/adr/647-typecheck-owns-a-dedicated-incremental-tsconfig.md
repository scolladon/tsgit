# 647 — check:types owns a dedicated incremental tsconfig

- **Status:** accepted
- **Date:** 2026-08-16
- **Design:** docs/design/perf-review-remediation.md (candidate D9)

## Context

Enabling TypeScript `incremental` cuts a warm unchanged `tsc --noEmit` from 9.22 s to
2.03 s on the measurement host. But three consumers read the project tsconfigs:
`check:types` (the target), rollup + typedoc through `tsconfig.build.json` (which
extends `tsconfig.json`; `@rollup/plugin-typescript` drives the compiler in-memory with
no coherent cache-file location, and this toolchain is fragile enough that TypeScript 7
crashes it), and Stryker's typescript-checker, which reads `tsconfig.json` directly and
creates a program per mutant under concurrency — concurrent checkers sharing one
`.tsbuildinfo` path is an unproven hazard.

## Options considered

1. **A dedicated `tsconfig.typecheck.json` extending `tsconfig.json`, carrying only
   `incremental` + `tsBuildInfoFile`; `check:types` points at it (design
   recommendation)** — pros: zero blast radius — rollup, typedoc and Stryker keep
   reading exactly what they read today / cons: one more config file.
2. **`incremental` in `tsconfig.json` + explicit `incremental: false` in
   `tsconfig.build.json`** — pros: no new file / cons: fixes rollup and typedoc but not
   Stryker.
3. **`incremental` in `tsconfig.json` only** — pros: smallest diff / cons: leaks into
   all three consumers.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** `check:types` becomes
`tsc --noEmit -p tsconfig.typecheck.json`; the new file extends `tsconfig.json` and adds
only the two incremental keys, and joins the task's wireit `files` list. No other
consumer's input changes.
