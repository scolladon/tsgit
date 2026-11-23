---
subjects:
  - src/domain/pathspec/compile-glob.ts
  - src/domain/glob/wildmatch.ts
---
# 1252 — The ignore-family glob matches bytes, encoded once per table fill

- **Status:** accepted
- **Date:** 2026-11-23
- **Design:** docs/design/wildmatch-bracket-class.md (G-d, DC-B, R3) · **Supersedes/Refines:** applies DOCTRINE(D-5); refines ADR-077

## Context

git's `dowild` compares bytes: `?` and a set consume one byte, so `?` does not match `é`, `??`
does, and `[é]` never matches `é` (rows Q2, Q3, Y1–Y4, SP11). `compileGlob` matches UTF-16 units,
so `?` matches `é` on main in all three consumers. A path string holds a lone U+DC80..U+DCFF for
each byte that is not valid UTF-8.

## Options considered

1. **Encode the folded path to bytes once per `test` call that reaches the table fill, after the
   string fast paths** (recommended).
2. Widen `GlobMatcher` with a bytes entry so each consumer encodes once per path.
3. Match UTF-16 units for an ASCII path and bytes otherwise.

## Decision

**Adopted-as-recommended (no user judgment)** — DOCTRINE(D-5) for the byte semantics: the `single`
token sits in the matcher the change rewrites. Option 1 for the representation, no trade-off: the
alternatives differ in mechanics, and the perf gate of ADR-1255 arbitrates. Option 2 is the
fallback if that gate fails.

## Consequences

### Positive

- `?` and sets agree with git on every multi-byte and escaped-byte path.

### Negative

- A `test` call that no fast path settles allocates the path's bytes.
