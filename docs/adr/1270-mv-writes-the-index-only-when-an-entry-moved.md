---
subjects:
  - src/application/commands/mv.ts
---
# 1270 — mv writes the index only when an entry moved

- **Status:** accepted
- **Date:** 2026-11-25
- **Design:** docs/design/whole-second-stat-match.md (What validation changed) · **Supersedes/Refines:** applies DOCTRINE(D-5); completes ADR-1268

## Context

The mutation triage of this change applied a mutant by hand and then probed `mv -k` with a
source git refuses, so that nothing moves. git 2.56.1, both `core.ignorecase` values:

| Shape | git | tsgit on main | this branch before the fix |
|---|---|---|---|
| no index file | none is created | an empty index is written | as main |
| `f` staged, rewritten at the same size in that second; `mv -k` a second later | index untouched, `f` size 4 | index rewritten with the same bytes | index rewritten, `f` recorded with size 0 |
| settled index | index untouched | index rewritten with the same bytes | as main |

git's `cmd_mv` ends with `write_locked_index(…, COMMIT_LOCK | SKIP_IF_UNCHANGED)`. When no
`rename_index_entry_at` ran, the index is unchanged and the lock is rolled back.

tsgit's `mv` committed the lock on every run that was not a dry run. On main that write changed
the index file's times and created a missing index, nothing else. ADR-1262 and ADR-1268 made
the index write of `mv` smudge by whole seconds, so on this branch the unneeded write also
changed an entry's recorded size.

## Options considered

1. **Commit the lock only when at least one index entry moved; release it otherwise**
   (recommended).
2. Keep the write and skip the racy smudge when nothing moved.
3. Leave it and record the divergence.

## Decision

**Adopted-as-recommended (no user judgment)** — DOCTRINE(D-5): the divergence sits in the
function this change edits, and its visible half is this change's own. Option 1.

Refused: option 2 still creates an index where git creates none and still moves the index
file's times. Option 3 ships a difference this change introduced.

## Consequences

### Positive

- An `mv` whose every source is skipped leaves the index file, its times and its absence as git
  does.
- The racy smudge runs in `mv` only when git's would.

### Negative

- None measured: the skipped write is work saved.
