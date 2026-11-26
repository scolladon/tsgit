---
subjects:
  - src/application/commands/mv.ts
  - src/application/primitives/internal/smudge-racily-clean.ts
---
# 1268 — A moved entry is refreshed and stays a smudge candidate

- **Status:** accepted
- **Date:** 2026-11-25
- **Design:** docs/design/whole-second-stat-match.md (What review changed) · **Supersedes/Refines:** applies DOCTRINE(D-2); completes ADR-1261 and ADR-1262

## Context

The security review of this change found a regression. Under `core.trustCtime=false` or
`core.checkStat=minimal`: stage `a`, rewrite it at the same size in the same second, then
`mv a b` a second later. git reports `AM b`, records size 0 for `b` and restores the staged
content on `checkout -- b`. tsgit reported `b` clean and kept the edited bytes.

git's `rename_index_entry_at` refreshes the moved entry. An entry whose content is unchanged
takes the stat the rename left and is up to date. A modified one keeps its stat and is not up
to date, so the index write smudges it when it is racy.

tsgit's `mv` only changed the entry's path. The smudge pass paired its candidates with the
index as read by path, so a moved entry was never a candidate. On main the nanosecond and ctime
compare hid both gaps: the rename moves ctime, and ctime always counted. ADR-1261 lets the
configuration drop ctime, which removed the mask.

A second effect predates this change: after `mv` of a clean file, git's entry carries the
rename's ctime and tsgit's kept the old one.

## Options considered

1. **`mv` refreshes each moved entry as git does, and the smudge pass picks its candidates by
   the stat data the index held when read, whatever the path** (recommended).
2. The smudge pass alone: candidates by stat data, `mv` unchanged.
3. `mv` hands the smudge pass the list of moved paths.

## Decision

**Adopted-as-recommended (no user judgment)** — DOCTRINE(D-2): the divergence has one half in
the index writer this change edits and one half in `mv`. Option 2 fixes the regression and
leaves the row for a clean moved file red. Option 1.

The smudge pass also leaves an entry alone when its path cannot be stat-ed at all, as git's
`ce_smudge_racily_clean_entry` returns on any `lstat` failure. Two `mv -k` rows with paths past
`PATH_MAX` reach that line once a moved entry is a candidate.

Refused: option 3 keeps path pairing as the rule and adds a second one beside it.

## Consequences

### Positive

- `mv` after a same-size edit is seen by `status` and undone by `checkout` under every stat
  policy, and the index bytes match git's.
- A clean moved entry records the stat the rename left, as git's does.

### Negative

- `mv` reads and hashes a moved file whose stat changed, as git does.
