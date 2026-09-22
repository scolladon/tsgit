---
subjects:
  - src/application/primitives/pack-registry.ts
  - src/application/primitives/internal/repo-state.ts
  - src/application/primitives/config-read.ts
---
# 882 — The pack window cache honours git's window keys as upper bounds and refuses malformed values

- **Status:** accepted
- **Date:** 2026-09-22
- **Design:** docs/design/node-io-cold-read-pipeline.md (D7, DC-2) · **Supersedes/Refines:** refines ADR-773 (pack config grammar) and ADR-859 (validation tiers)

## Context

`collectDeltaChain` issues one `pread` per delta level (44 for a 43-deep leaf) and every
`readSlice` zero-fills a fresh buffer. Git's `use_pack` keeps mmap windows per pack under
`core.packedGitWindowSize` and a process-wide `core.packedGitLimit`. tsgit ignores both keys.
Pinned on git 2.55.0 in a throwaway repository: both keys are read by `git_default_config`, so a
malformed value (`abc`, `-1`, an empty or valueless entry, or a value past `unsigned long`)
makes **every** command die — `cat-file`, `rev-parse` and `status` alike — with
`fatal: bad numeric config value '<v>' for '<key>' in file .git/config: invalid unit` (or
`out of range`), the key printed lowercase. tsgit accepts those values silently today: a
pre-existing faithfulness gap. Git's defaults (1 GiB window, 32 TiB limit on 64-bit) are mmap
reservations paged lazily; a tsgit window is an eager heap read, so copying the numbers would
read a whole pack on first touch.

## Options considered

1. **tsgit-only options, git keys ignored** — pros: no config read / cons: the malformed-key gap
   stays open; a second knob vocabulary next to git's.
2. **Honour both keys as upper bounds, refuse malformed values at the eager tier** — pros: git's
   names and grammar, closes the gap, a user can shrink the cache on a constrained host / cons:
   one new refusal class on every command. *Recommended by the design.*
3. **Option 2 plus explicit override options that suppress the keys (the ADR-858 shape)** — pros:
   programmatic control / cons: no requester today.

## Decision

**Option 2 — the user's judgment, as recommended.** The window cache defaults to a 64 KiB
window and a 16 MiB registry-wide byte limit with LRU eviction across packs.
`core.packedGitWindowSize` and `core.packedGitLimit` are read with the grammar and reasons of
`pack.windowMemory` (the unsigned-long finder of ADR-773) and can only **lower** the defaults; a
value above a default is clamped to it, because git's figures are mmap sizes tsgit cannot honour
as heap. A malformed value refuses through `configBadNumericValue` from `assertEagerConfigValid`
on every command, in lowest-line ordering with the other eager keys; this is the eager tier
(git's `git_default_core_config`), not ADR-859's repo-settings tier. The cache is cleared exactly
where the delta-base cache is cleared. The 64 KiB default window is confirmed or replaced by
the delta-chain probe on the spread row before merge.

## Consequences

- A repository whose config carries a malformed window key now refuses every command exactly as
  git does; the interop rows pin the message shape and the affected commands.
- The window and limit live in the pack registry (application layer), so the browser adapter
  gets the same cache; the Node sync arm makes each window load one `pread`.
- Programmatic override options remain additive if a consumer ever needs them.
