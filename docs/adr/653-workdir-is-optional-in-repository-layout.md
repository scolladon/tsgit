# 653 — `workDir` is optional in `RepositoryLayout`

- **Status:** accepted
- **Date:** 2026-08-18
- **Design:** docs/design/bare-repo-custom-gitdir.md (candidate D1)

## Context

The layout must express four measured states: ordinary repo, bare repo, worktree-less
non-bare (`cd normal/.git`), and bare-flagged with an explicit work tree
(`--git-dir=bare.git --work-tree=…`). Today `workDir` is an always-present `string`,
which is how tsgit fabricates a work tree git refuses to provide — commands read a path
that should not exist.

## Options considered

1. **`workDir?: string` optional; `bare` stays the computed `is_bare_repository()`
   formula (design recommendation)** — pros: every unguarded `layout.workDir` read
   becomes a compile error the work-tree gate resolves by returning the value, making
   the sweep audit mechanical / cons: a type-level breaking change for callers reading
   `repo.ctx.layout.workDir` as `string`.
2. **Always-populated `workDir` (gitDir when absent) plus a `hasWorkTree` flag** — no
   breaking change, but a string that must not be read is exactly the footgun that
   produced the fabricated-work-tree defect; the compiler cannot help.
3. **Discriminated union on a `kind` tag** — four states need four arms; churns every
   `ctx.layout.gitDir` read; the optional field with ceremony.

## Decision

**Option 1 — ratified by the user.** `workDir` becomes optional; `bare` remains a
computed boolean, never a synonym for "no work tree". The breaking change is called out
in the docs page and release notes.

## Consequences

`layoutRootsOf` drops the absent candidate (bare root set `[gitDir]`); `Context.cwd`
falls back to `gitDir`; `assertRepository` roots at `workDir ?? gitDir`; every remaining
`workDir` read sits behind the gate that returns the narrowed value.
