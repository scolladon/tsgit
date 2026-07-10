# 471 — deep-delta-chain bench fixture: evolving blob at near-cap depth

- **Status:** accepted
- **Date:** 2026-07-10
- **Design:** docs/design/memory-pressure-bench-scenarios.md · **Relates:** ADR-472, ADR-473, ADR-474

## Context

The scaled bench fixtures fill blobs with xorshift32 high-entropy random bytes, which
`git repack` cannot deltify — today's packs carry no deep delta chains, so nothing
exercises the iterative delta-base walker (`resolveObject`) or the LRU delta-base cache
under chain pressure. A deep-delta-chain scenario needs content that is *similar across
successive objects*. The hard constraint: tsgit's `MAX_DELTA_CHAIN_DEPTH = 50`
(`src/domain/storage/delta.ts`) is set to git's own default `pack.depth`, so any chain
deeper than 50 throws `DELTA_CHAIN_TOO_DEEP` — the fixture must stay at or under 50.
Pinned against the real `git` binary in an isolated `mktemp` throwaway.

## Options considered

1. **Evolving blob, near-cap** — one 4 KiB blob mutated ~1 %/commit, then
   `git repack -adf --depth=50 --window=250` → max chain length **43**. git's default
   depth cap (50) with a wider-than-default search window (git default `window=10`).
   Deepest stress the reader will ever legitimately face; ~180 KiB pack, generates in
   under a second.
2. **Evolving blob, git defaults** — same content, `--depth=50 --window=10` (literally
   what a normal `git gc` produces) → max chain **37**. Most representative of a typical
   real-world pack; a shade less aggressive as a stress test. *(design recommendation)*
3. **Many near-duplicate blobs** — copies of a base with small per-blob edits instead of
   one evolving file. More generator code, and cross-blob deltas muddy the "one deep
   chain" signal.

## Decision

Adopt option 1 — **an evolving 4 KiB blob mutated ~1 %/commit, packed with
`git repack -adf --depth=50 --window=250` for a max chain length ≈ 43** (user-ratified;
the user chose the near-cap depth over the git-default-window recommendation, because a
*memory-pressure* benchmark should stress the delta walker at the deepest point tsgit
will accept). Both option 1 and option 2 keep git's default depth cap of 50 — only the
search window differs — so a chain-43 pack is nothing a default-packed real repository
could not contain; `git gc --aggressive`'s `--depth=250` is deliberately *not* used
(tsgit refuses those chains).

Because git deltifies **backwards in time** here — pinned: `repack` stored the newest
(HEAD) version as the non-delta base at depth 1 and deltified older versions against it,
so the deepest object is an *older* version, not HEAD — the generator records the
**deepest-chain object's id** for the scenario to read. That id is taken authoritatively
from `git verify-pack -v` (the blob line with the maximum chain-depth column), never
assumed to be HEAD or root. This is deterministic: same seed + same git → same pack →
same deepest object.

## Consequences

- The fixture measures a genuine deep chain-walk while every object stays resolvable by
  tsgit's own reader (≤ 50).
- The generator gains a `git verify-pack -v` parse step to locate the deepest object;
  run env-isolated like every other `git` call.
- Should a future git change its packing heuristics and push a chain past 50, the leaf
  read throws `DELTA_CHAIN_TOO_DEEP` loudly inside the measured closure — a signal to
  re-pin, not a silent skew.
