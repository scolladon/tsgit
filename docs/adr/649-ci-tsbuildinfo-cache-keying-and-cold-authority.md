# 649 — CI .tsbuildinfo cache keying, and typecheck stays the cold authority

- **Status:** accepted
- **Date:** 2026-08-16
- **Design:** docs/design/perf-review-remediation.md (candidate D11)

## Context

Nineteen tsc payments per PR run flow through wireit tasks depending on `check:types`
(17 job-instances + benchmark-compare's two tree builds); eleven run on `ubuntu-latest`.
No CI cache exists for the type-check. The brief's constraint: exactly one job must
remain a clean-run authority so a stale or poisoned cache file can never mask a type
error.

## Options considered

1. **`actions/cache` keyed `runner.os` + resolved Node version +
   `hashFiles('tsconfig*.json','package-lock.json')` + source-hash suffix, with a
   `restore-keys` prefix; the `typecheck` job skips the cache entirely (design
   recommendation)** — pros: cleanest cold authority — one job that never sees a cache;
   cross-OS reuse impossible by key / cons: the typecheck job stays at its cold ~37 s.
2. **Same key; `typecheck` restores without saving** — pros: faster typecheck job /
   cons: a poisoned cache could mask an error in the one job whose only purpose is the
   check.
3. **Ubuntu-only cache** — pros: nothing / cons: forgoes the macOS/Windows savings for
   no correctness gain the key does not already provide.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** Cache steps use
`actions/cache` on a floating major tag, restored before and saved after the
type-consuming step, keyed as above with `restore-keys` prefix reuse for source-only
changes. The `typecheck` job runs cold, always, and remains the authority.
