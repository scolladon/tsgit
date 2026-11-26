---
subjects:
  - src/domain/ignore/matcher-stack.ts
  - src/application/primitives/internal/ignore-evaluator.ts
  - src/application/primitives/is-ignored.ts
  - src/application/primitives/internal/occupant-clash.ts
---
# 1272 — The leading-directory rule is a pure domain function behind one session

- **Status:** accepted
- **Date:** 2026-11-26
- **Design:** docs/design/is-ignored-leading-directory.md (DC-1, §1, §2) · **Supersedes/Refines:** serves ADR-1271; applies DOCTRINE(D-2)

## Context

The full-path judgement exists twice: in `isIgnored`, and in `buildRepoIgnorePredicate`, which
the per-path probe `createIgnoredProbe` wraps. Each copy has its own `ancestorsOf` and its own
loading loop. The rule of ADR-1271 has to reach both, and the probe copy is the one behind
every overwrite pre-flight.

The rule has two halves. The verdict is a function of the rule levels and the path. What is
read from disk, and when, is input and output.

## Options considered

1. **Pure domain functions beside `matchInStackVerbose` (`leadingDirectoriesOf`,
   `directoryExclusion`, `matchBeneathLeadingDirectories`, the exclusion lookup injected), and
   one application `createIgnoreSession` that loads lazily and keeps one verdict per directory,
   behind both `isIgnored` and `buildRepoIgnorePredicate`** (recommended).
2. The whole walk inside the application session, with no domain function.
3. Fix `isIgnored` and the predicate separately.

## Decision

**Adopted-as-recommended (no user judgment)** — the dependency rule of the architecture (the
domain is pure, loading belongs to the application) and DOCTRINE(D-2): one rule for every
consumer. Option 1.

Both `ancestorsOf` copies and the two loading loops are removed. `createIgnoredProbe` keeps
wrapping `buildRepoIgnorePredicate` and takes the rule through it.

Refused: option 2 forces the properties through a file-system adapter. Option 3 keeps two
copies of a rule that has already drifted once.

## Consequences

### Positive

- The verdict is tested by properties without input or output.
- One loading loop decides which `.gitignore` files are read.

### Negative

- A directory's verdict is kept for the life of a session, so a `.gitignore` rewritten during
  one command is not read again. The rules were already kept that way.
