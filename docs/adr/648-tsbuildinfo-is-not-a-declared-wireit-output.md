# 648 — The .tsbuildinfo is not a declared wireit output

- **Status:** accepted
- **Date:** 2026-08-16
- **Design:** docs/design/perf-review-remediation.md (candidate D10)

## Context

wireit's default `clean: true` deletes a task's declared outputs before each run.
Declaring the `.tsbuildinfo` as an output of `check:types` without `clean: false` would
delete the cache on every executed run and leave `tsc` permanently cold — silently
voiding the entire win. The two caches otherwise compose: wireit skips the task when
input hashes are unchanged; the TypeScript cache pays off on exactly the runs wireit
does execute.

## Options considered

1. **Leave it undeclared — `output: []` as today (design recommendation)** — pros:
   smallest change with the full local win; the cache file simply persists on disk
   (already gitignored) / cons: does not survive `.wireit/cache` restore across branch
   switches.
2. **Declare it with `clean: false`** — pros: additionally survives branch switches via
   wireit's cache / cons: introduces a caching semantic to a task that never had one.
3. **Declare it with default `clean`** — not viable: permanently cold, listed only to be
   ruled out.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** `check:types` keeps
`output: []`; the `.tsbuildinfo` persists on disk under its gitignored name and is
invisible to wireit.
