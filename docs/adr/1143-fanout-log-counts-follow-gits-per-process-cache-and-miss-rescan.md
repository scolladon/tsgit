---
subjects:
  - src/application/primitives/resolve-oid-prefix.ts
---
# 1143 — fanout log counts follow git's per-process cache and miss rescan

- **Status:** accepted
- **Date:** 2026-11-04
- **Design:** docs/design/rev-parse-corrupt-input.md · **Supersedes/Refines:** refines ADR-509, ADR-222

## Context

git logs the unreadable-directory line twice on `rev-parse abcd`, three times on `cherry-pick abcd`
and on a name that resolves to nothing, and once on a packed hit or `rev-parse --short` (pinned twice
each on 2.56.0). The mechanism, from the sources: a failed listing is cached as empty for the rest of
the process (the fanout's seen bit is set even when the directory open fails), and `get_short_oid` scans a
second time after `odb_reprepare` when the first scan finds nothing; `find_unique_abbrev` has no
rescan. The existing ambiguity interop suite pins its logs "once per read git makes".

## Options considered

1. **A per-session memo of failed fanout directories plus one rescan when `resolveOidPrefix` finds no
   candidate** — pros: reproduces every pinned count / cons: one more session-keyed cache. The
   designer's recommendation.
2. **Stateless: log on every scan, rescan on a miss** — cons: four lines where git prints three.
3. **One log per resolution** — cons: one line where git prints two.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** `resolve-oid-prefix.ts` keeps a
`WeakMap<Session, Set<string>>` of fanout directories whose listing failed, keyed on `ctx.session` as
`loose-oid-cache.ts` keys its cache (ADR-509). A memoised directory answers an empty listing without a
read and without a log. When `resolveOidPrefix` finds no candidate it drops the memo entries for the
directories this call consulted and scans once more; `abbreviateObjectId` never scans again. Successful
listings are never cached.

## Consequences

- Counts match git on every pinned route: 2 on a miss, 3 with the sequencer's second read
  (ADR-1146) or the misspelt reread, 1 on a packed hit and on `--short`.
- A long-lived `Context` logs fewer lines on a later command than a fresh git process would — the
  same equation ADR-509 already accepts for the loose-object cache.
