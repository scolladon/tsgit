---
subjects:
  - test/bench/ignore-match.bench.ts
  - test/perf/domain/pathspec/compile-glob.perf.test.ts
---
# 1255 — The ignore-match bench gates class rules against a floor twin

- **Status:** accepted
- **Date:** 2026-11-23
- **Design:** docs/design/wildmatch-bracket-class.md (DC-E, R12) · **Supersedes/Refines:** applies ADR-077

## Context

`status` and `add` test every walked path against every ignore rule. The change replaces the
matcher under them and adds a byte encode to calls no fast path settles. Main reads `[…]` as
literal text, so it is no yardstick for a rule set that holds classes.

## Options considered

1. **A new ignore-match bench with two gates, plus two bound rows in the perf test**
   (recommended).
2. Bound rows only.
3. Add a `.gitignore` to the existing `status` bench.

## Decision

**User-ratified — option 1.** The bench walks 20000 paths against a 40-rule `.gitignore`:

- a rule set without classes costs at most 10% more than on main, where main is already faithful;
- a rule set with classes costs at most 25% more than a twin whose every set is replaced by `?`:
  the same token count with a one-byte test, which is the floor git itself pays.

The perf test gains a match bound (`'[a-z]*'.repeat(64) + 'b'` against 10000 `a`) and a compile
bound (`'[' + '[:'.repeat(100000) + 'x]'`), each under 1000 ms.

Refused: option 2 proves the bound and says nothing about the hot path. Option 3 shifts the
history of the `status` series.

## Consequences

### Positive

- A regression on class-free rule sets and an over-priced set test are both caught.

### Negative

- One more bench file to keep quiet-machine discipline on.
