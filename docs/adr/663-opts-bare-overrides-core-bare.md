# 663 — `opts.bare` overrides `core.bare` outright

- **Status:** accepted
- **Date:** 2026-08-18
- **Design:** docs/design/bare-repo-custom-gitdir.md (candidate D11)

## Context

git has no `--bare` setup flag, so no pin determines what an explicit `bare` argument
means relative to `core.bare` — the one choice in this feature genuinely undetermined
by measurement. Every other precedence row is argument-tier-beats-config-tier
(`opts.workDir` beats both `core.bare` and `core.worktree`), and the browser shim's
existing `bare` option is already caller-supplied and absolute.

## Options considered

1. **Override outright: `true` behaves as `core.bare = true` (no default work tree),
   `false` ignores the config value (design recommendation)** — pros: consistent with
   the argument-tier precedence everywhere else; both values meaningful / cons: none
   material.
2. **Floor only: `true` forces bare, `false` defers to config** — makes `bare: false`
   an option that silently does nothing.
3. **Refuse a conflict with `core.bare`** — no way to open a `core.bare = true` repo
   non-barely without also passing `workDir`.

## Decision

**Option 1 — ratified by the user.** A malformed `core.bare` still refuses at open time
even when `opts.bare` is supplied — the config is read and validated regardless,
matching git's every-command validation.
