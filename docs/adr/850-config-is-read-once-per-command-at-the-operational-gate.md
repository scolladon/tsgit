---
subjects:
  - src/application/primitives/config-read.ts
  - src/application/primitives/internal/repo-state.ts
---
# 850 — Config is read once per command, at the operational gate

- **Status:** accepted
- **Date:** 2026-09-11
- **Design:** docs/design/session-caches-per-command-floor.md (D5, DC-1) · **Supersedes/Refines:** none

## Context

`readConfig` validates its cache entry with a `stat` of `.git/config` on every **sequential**
call; the existing coalescing only collapses *concurrent* stats. With 48 call sites — one per
object written in `write-object.ts`, one per `walkTree` across eleven callers, two back to back
in `record-ref-update.ts` — a merge pays 15 stats and the medium closure paid 10 010 before the
closure hoist removed its share.

The freshness that buys is stricter than git's: git is one process per command, reads config
once through `git_default_config`, and dies on a malformed value. tsgit is *also* less faithful
than git in one place the per-read stat does not cover — the operational gate's verdict is
memoised per session and never re-validated, so a `[core]` value made malformed by an external
writer after the first command is refused by **no** later command, while `readConfig`'s own
consumers do see the edit. The per-read stat and the never-re-read verdict are the same
question asked at two different layers, answered inconsistently.

## Options considered

1. **Gate-armed epoch** (recommended, chosen) — one `stat` in `assertOperationalRepository`
   marks the entry `trusted`; every `readConfig` in that command skips its own stat; the gate
   verdict is re-keyed on the same stat. Pros: git's own model; closes the verdict gap; removes
   47 stats from a merge. Cons: a command that never reads config pays one stat more than today.
2. **Lazy epoch** — the gate only *clears* `trusted`; the first `readConfig` stats. Pros:
   config-free commands pay nothing. Cons: leaves the verdict gap exactly as it is.
3. **Keep per-read stats** — ship only the `record-ref-update` fold. Pros: no contract change.
   Cons: leaves the per-object and per-`walkTree` stats, and the verdict gap, in place.

## Decision

**Option 1.** The operational gate is the freshness boundary for config. `assertOperationalRepository`
performs exactly one `stat` of `.git/config` after the HEAD check; an unchanged key marks the
cache entry `trusted` for the remainder of that command, and a changed key drops both the parse
entry and the gate-verdict memo so the verdict is re-derived from fresh tokens, as git's
per-process read would. A session that never runs a gate — primitive-only use — keeps today's
per-read stat validation. `assertRepository`, the bare gate behind the `config` porcelain, opens
no epoch; its readers are the scoped cache, which keeps its own per-call stat.

**The contract, stated for future work:** a config file changed by tsgit's own writers is seen
on the next read, unchanged, because those writers call `invalidateConfigCache`. A **raw
external write** is seen at the next operational gate — that is, the next command — or at the
next explicit `invalidateConfigCache`. Same-millisecond same-size rewrites were already
undetectable through the `mtimeMs:size` key and remain so.

## Consequences

Commands that read config pay the same single stat as today, moved from their first `readConfig`
to the gate. Commands that read none — `catFile`, `readBlob`, `revParse` — pay one stat more,
which is the price of the refusal git makes and tsgit did not; that cost is a libuv round trip
today and roughly a microsecond once the adapter's sync-metadata strategy lands.

Tests that seed `.git/config` with a raw `writeUtf8` **between** a gated command and a directly
called config-reading primitive must now call `invalidateConfigCache(ctx)` after the write. The
affected set is enumerated mechanically — land the epoch, run the unit suite, and every failure
is one of these — and is expected to be single digits, because tests overwhelmingly seed config
in Arrange before the first command, and primitive-only tests arm no epoch at all.

Nested gates re-stat, which is one harmless extra hop. `__resetConfigCacheForTests` resets the
`trusted` bit along with the entry.
