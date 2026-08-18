# 662 — `init`/`clone` with `bare: true` do not relocate their gitDir

- **Status:** accepted
- **Date:** 2026-08-18
- **Design:** docs/design/bare-repo-custom-gitdir.md (candidate D10)

## Context

`bootstrapRepository` writes byte-correct bare shapes at `ctx.layout.gitDir`, and
`init`'s contract has always required the caller to construct a Context whose
`gitDir === workDir` for bare — a Context `openRepository` could not build until the
explicit `gitDir`/`bare` options existed. git is equally lenient at the same edge:
`git --git-dir=<empty dir> init` succeeds while `log` there refuses.

## Options considered

1. **No relocation — commands keep writing at the layout's gitDir; the caller opens
   with `gitDir`/`bare` to get a bare-shaped Context (design recommendation)** — pros:
   the layout decision stays in exactly one place (`openRepository`); today's contract,
   now reachable / cons: bootstrapping bare requires passing the options.
2. **`init({ bare: true })` rewrites its own layout to `gitDir === workDir`** — a
   command silently mutating the layout its Context was built with, leaving
   `repo.layout` stale on the very handle that ran it.
3. **Refuse `init({ bare: true })` on a non-bare layout** — refuses the legal and
   useful bootstrap shape option 1 enables.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** Keeps command/Context
responsibilities separated (CQS); round-trip symmetry is proven by the interop
scenarios instead of by relocation magic.
