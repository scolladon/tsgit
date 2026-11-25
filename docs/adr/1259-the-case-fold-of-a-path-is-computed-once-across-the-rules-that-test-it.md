---
subjects:
  - src/domain/pathspec/compile-glob.ts
---
# 1259 — The case fold of a path is computed once across the rules that test it

- **Status:** accepted
- **Date:** 2026-11-24
- **Design:** docs/design/wildmatch-bracket-class.md (§3, §4) · **Supersedes/Refines:** refines ADR-1251 and ADR-1252

## Context

Under `caseFold`, `compileGlob`'s matcher lowers the path on every `test` call. A rule set tests
each walked path against every rule, so the same path is lowered once per rule. `core.ignorecase`
is true by default on macOS and Windows, and ADR-1251 makes the ignore and attribute readers fold.

Measured on the ignore-match workload (20200 paths against 40 rules without sets, best of 15,
reproduced twice): 26 ms case-exact; 72 ms folded on lower-case paths and 123 ms on mixed-case
paths. With the fold computed once per path: 28 ms and 32 ms. A lowercase that scans for an upper
case letter first was no faster (87 and 107 ms). The same workload costs 262 ms on main, which
does not fold, so nothing regresses against main. The gate of ADR-1255 runs case-exact and does
not see this cost.

## Options considered

1. **A single-entry memo in `compile-glob.ts`: the last path and its fold** (recommended).
2. Fold once in each rule loop (ignore, attributes, sparse) and give the matcher an entry for
   text already folded.
3. Keep one fold per rule.

## Decision

**User-ratified — option 1.** `compile-glob.ts` keeps the last path it folded and its result;
every matcher compiled with `caseFold` reads it. The fold stays `asciiLower`, a pure function of
the path, so the memo cannot change a verdict.

Refused: option 2 adds a member to `GlobMatcher`, which the public `IgnoreRule.compiled` exposes,
and changes three consumers for the same measured gain. Option 3 leaves a 2.8 to 5 times cost on
the default configuration of two platforms.

## Consequences

### Positive

- A folded rule set costs within a fifth of a case-exact one on this workload, with no change
  to any signature or contract.

### Negative

- One piece of module-level mutable state in a domain module. It caches a pure function and is
  never observable through a verdict.
- A caller that alternates between two paths per rule gains nothing.
