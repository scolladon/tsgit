---
subjects:
  - test/unit/domain/pathspec/compile-glob.properties.test.ts
  - test/unit/domain/pathspec/arbitraries.ts
---
# 1258 — The class grammar is property-tested against a recursive reference

- **Status:** accepted
- **Date:** 2026-11-23
- **Design:** docs/design/wildmatch-bracket-class.md (DC-H) · **Supersedes/Refines:** applies ADR-134

## Context

The matcher is a table fill; git's `dowild` is a backtracking recursion. With one shared core
(ADR-1248), agreement between `compileGlob` and `compilePathnameGlob` would compare the core with
itself.

## Options considered

1. **A test-side port of git's recursive `dowild`, run on short patterns over a small alphabet,
   plus invariants** (recommended).
2. Invariants only.
3. Agreement with `compilePathnameGlob`.

## Decision

**Adopted-as-recommended (no user judgment)** — no trade-off: the alternatives differ in
mechanics. Option 1. The port lives beside the tests and is never shipped.

## Consequences

### Positive

- Two different algorithms must agree, which catches cross-branch grammar bugs (`[]-a]`, `[[:]]`).

### Negative

- The reference is one more reading of `dowild` to keep faithful.
