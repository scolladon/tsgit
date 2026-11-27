# `writeExclusive` with a file parent — pin the shipped refusal

## Goal & scope

Backlog 32.1 row D5 says `NodeFileSystem.writeExclusive` refuses `FILE_EXISTS`
when the parent of the target is a file. Callers read that as "lock held", and
`write-object` reads it as "object already exists", so on Node the write
succeeds silently. The memory adapter and the OS refuse `NOT_A_DIRECTORY`.

The row no longer holds on main. #317 (7337e22e) replaced the unconditional
parent `mkdir` with a create-first `writeFile(wx)`. That `mkdir` turned the file
parent into `EEXIST`, so `FILE_EXISTS`. Create-first gets `ENOTDIR` instead and
only falls back to `mkdir` on `ENOENT`, so the error maps to `NOT_A_DIRECTORY`.

This change is a pin and a backlog strike. It changes no source.

## Evidence (main @ 6a788fc2, git 2.56.1, scrubbed `GIT_*`)

| probe | git | tsgit |
|---|---|---|
| `add new`, `objects/<xx>` planted as a file | refuses: `unable to create temporary file: Not a directory`; no index entry | refuses `NOT_A_DIRECTORY`; no index entry, no object |
| `branch a/b` over loose `refs/heads/a` | refuses: `'refs/heads/a' exists` | refuses `NOT_A_DIRECTORY`; no lock left |
| `tag a/b` over loose `refs/tags/a` | refuses | refuses `NOT_A_DIRECTORY`; no lock left |
| `branch a/b/c` over loose `refs/heads/a` | refuses | refuses `NOT_A_DIRECTORY`; no lock left |
| adapter `writeExclusive(<file>/leaf)` | — | `NOT_A_DIRECTORY` |
| adapter `writeExclusive(<file>/q/leaf)` | — | `NOT_A_DIRECTORY` |

The exit and data agree with git in every row. The ref-row wording differs
(`exists; cannot create` vs `not a directory`), but that is message only and
below the filing bar (ADR-1170), and ADR-249 keeps rendered text out of the
library.

## Change

- `test/unit/ports/file-system.contract.ts`: the comment above the grandparent
  row says depth 1 is "adapter-dependent — Node reports FILE_EXISTS". That is now
  false. Replace the comment with a depth-1 row that runs on every contract
  driver (node, memory): a file at the immediate parent makes `writeExclusive`
  throw `NOT_A_DIRECTORY`, and the parent file keeps its bytes.
- `docs/BACKLOG.md`: strike D5 in 32.1 and in the Release-order cut-3 row, and
  cite #317 and this design.

## Out of scope

- The ref D/F refusal wording (message only, see above).
- `docs/known-divergences.md`: nothing diverges, so no row goes there.

## Decision candidates

None. The user chose "pin + strike" in the session before the run opened.
