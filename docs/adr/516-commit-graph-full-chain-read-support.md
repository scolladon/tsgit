# 516 — Commit-graph read support: full chain/split format + parent prefetch + header cache

- **Status:** accepted
- **Date:** 2026-07-27
- **Design:** docs/design/close-isogit-perf-gap.md · **Supersedes/Refines:** none

## Context

Commit walking is 12× slower than `git rev-list`: every parent/date comes from a full object read, sequentially awaited, while git serves walks from the mmap'd commit-graph. The graph exists in two on-disk forms: the single `objects/info/commit-graph` file and the chain/split form (`commit-graphs/commit-graph-chain` + `graph-<hash>.graph` layers). The design recommended deferring chain/split; the user's standing default is no deferred follow-ups.

## Options considered

1. **Single-file read only** — pros: smallest parser / cons: repos maintained by `git fetch`/`gc` with split graphs fall back to slow object reads.
2. **Single-file + parallel parent prefetch + per-repo header cache (designer's recommendation)** — pros: common case + idle-time attack / cons: defers chain/split as a follow-up.
3. **Full chain/split + prefetch + cache** — pros: complete format coverage, no deferred scope / cons: bigger parser + more fixtures in this PR.

## Decision

**Option 3 (user-ratified, deviating from the design recommendation).** The read-side commit-graph support parses both the single-file and the chain/split forms (chunk-table-driven, layered lookup base→tip, EDGE chunk for octopus parents), serves parents/generation/committer-date to `walkCommits`/`walkCommitsByDate` through the `FileSystem` port, and falls back to `readObject` for commits absent from the graph. Ride-alongs land too: bounded parallel parent-frontier prefetch (8–16 in flight) and a per-repository parsed-commit-header cache.

## Consequences

All commit-graph-bearing repos — including split-graph ones — get git-competitive walks; nothing is deferred. The parser is a decoder with round-trip and total-function property tests; interop pins graph-present vs graph-absent walks identical to each other and to `git rev-list`. Write-side `commit-graph` generation stays out of scope.
