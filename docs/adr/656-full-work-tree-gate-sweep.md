# 656 — Full work-tree-gate sweep in one change

- **Status:** accepted
- **Date:** 2026-08-18
- **Design:** docs/design/bare-repo-custom-gitdir.md (candidate D4)

## Context

28 command sites call `assertNotBare` (the wrong predicate — it answers "is bare", not
"may I touch a work tree"), and 9 further commands are ungated or need conditional
gating (`status`, `stash list`/`pop`, `grep`, `blame`, `describe --dirty`, `diff`
worktree shapes, `submodule` verbs, `reset --mixed`). The measured refusal matrix shows
both false-permits and false-refusals today, including a linked worktree of a bare repo
where `repo.add()` refuses what `git add` stages.

## Options considered

1. **Full sweep — repoint all 28 sites to `requireWorkTree` and add the 9
   missing/conditional gates in this change (design recommendation)** — pros: closes
   every measured divergence at once; the gate is a one-line synchronous call at sites
   that already carry a guard line / cons: widest diff.
2. **Repoint the existing 28 only** — ships a `status` that operates on a work tree git
   says does not exist; leaves the linked-worktree inconsistency half-fixed.
3. **Central facade gate over a static command list** — cannot express the measured
   conditional rows (`grep --cached`, bare `blame`, `describe --broken`, `reset
   --soft`, `diff --cached` all must keep working).

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** Anything narrower ships known
divergences, which the git-faithfulness prime directive (ADR-226) forbids.
