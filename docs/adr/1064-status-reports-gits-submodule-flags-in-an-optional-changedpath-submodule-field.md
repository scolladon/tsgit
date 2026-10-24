---
subjects:
  - src/application/commands/status.ts
---
# 1064 — `status` reports git's submodule flags in an optional `ChangedPath.submodule` field

- **Status:** accepted
- **Date:** 2026-10-24
- **Design:** docs/design/status-gitlink-parity.md · **Supersedes/Refines:** refines ADR-249 and ADR-255

## Context

`git status --porcelain=v2` prints a submodule field `S<c><m><u>` on every gitlink row: the
commit changed, the submodule has tracked changes, the submodule has untracked files (design rows
ST7, ST11–ST16). The library returns structured data and the interop test rebuilds git's line
from it (ADR-249). `ChangedPath` has no field that can carry the three flags, and
`unstaged: 'modified'` alone cannot say which of them set it.

## Options considered

1. **`submodule?: { commitChanged, trackedChanges, untrackedChanges }` on `ChangedPath`**,
   present only on gitlink rows — the designer's recommendation. Pros: the v2 field is data git
   reports; additive and optional. Cons: a public field lands in a fix-only change.
2. **No new field** — the flags fold into `unstaged: 'modified'`. Porcelain v1 can be rebuilt,
   v2's submodule field cannot.
3. **Option 1, also on `UnmergedEntry`** — no pinned row shows an unmerged gitlink, so the
   field would be speculative.

## Decision

**The user chose option 1.** The user also ruled on the commit type: the field, and the one
error-union member ADR-1069 adds, land under `fix:` — the change corrects `status` to the data
git reports, and #326 added `GITFILE_TOO_LARGE` under `fix:` the same way.

## Consequences

- `ChangedPath.submodule` is set on every gitlink row `status` keeps; it is absent on every other
  row. The interop test rebuilds `1 .M S<c><m><u> 160000 160000 <mW> …` from the field.
- `reports/api.json` and `docs/use/commands/status.md` change with the field.
- Release-please cuts a patch release.
