---
subjects:
  - tooling/bench-summarize.ts
---
# 808 — bench-summarize exports its pure functions in place and guards main

- **Status:** accepted
- **Date:** 2026-09-04
- **Design:** docs/design/bench-snapshot-summary-adr-lint.md (D9) · **Supersedes/Refines:** refines ADR-056

## Context

`tooling/bench-summarize.ts` exports nothing and runs its `main()` at import time, so its
rendering cannot be unit-tested, and tooling sits outside the coverage and mutation gates.
Its sibling `tooling/bench-to-snapshot.ts` already has the shape that works: pure exported
functions and a `main()` guarded by an invoked-directly check.

## Options considered

1. **Export the pure functions from the same file and guard `main()`** (designer's
   recommendation) — pros: the smallest diff; one house pattern for two sibling scripts; no new
   import specifier to get right under the strip-types runner.
2. **A new render module with a thin CLI wrapper** — cons: separation a hundred-line script does
   not need; one more whitelist entry.
3. **Share the raw-report types with `bench-to-snapshot.ts`** — cons: foreclosed by ADR-056,
   which has each script own its read of the external vitest schema.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** The row and document renderers are
exported from `bench-summarize.ts`; `main()` runs only when the file is the process entry. The
new unit test and the script are added to the biome whitelist. `npm run bench:summary` is
unchanged in command, input and output path.

## Consequences

Every rendering branch has a unit test that is the only mechanical guard for it. The two
scripts keep independent schema views per ADR-056.
