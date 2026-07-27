# 513 — Whitespace diff: streaming rolling-hash predicate + int-array Myers for stat

- **Status:** accepted
- **Date:** 2026-07-27
- **Design:** docs/design/close-isogit-perf-gap.md · **Supersedes/Refines:** optimises the path shipped by ADRs 378–382

## Context

`ignoreWhitespace` diff materialises every modified blob pair, decodes to strings, splits lines, and normalises per line even when the caller only needs "did any significant change survive?" — 24× slower than git, 4.7× peak memory, 80% of CPU in line-diff + GC. The drop-pass predicate and the stat-counting path have different needs.

## Options considered

1. **Rolling-hash predicate; keep string Myers for `withStat`** — pros: biggest win where it hurts / cons: stat path keeps the GC storm.
2. **Intern lines to ints for both paths** — pros: one representation / cons: no early-exit streaming predicate.
3. **Rolling-hash predicate + int-array Myers for stat (recommended)** — pros: each mechanism where it pays; predicate streams raw bytes with `WhitespaceMode` folded into a per-line rolling hash and early-exits on first significant mismatch; stat path runs Myers over interned ints (git's approach) / cons: two mechanisms to keep verdict-consistent.

## Decision

**Adopted-as-recommended (no user judgment) — Option 3.** The drop-pass predicate streams both blobs, applies whitespace normalisation at the byte level into a rolling per-line hash, and early-exits without Myers. `withStat: true` interns normalised lines to ints and runs Myers over int arrays. An interop test pins both paths' agreement against `git diff --ignore-all-space` / `--ignore-space-change` / `--ignore-space-at-eol`.

## Consequences

Whitespace-mode diff targets ~2× plain-mode cost with flat memory. Commits us to keeping the predicate and stat verdicts provably consistent (shared normalisation rules, pinned by interop + property tests).
