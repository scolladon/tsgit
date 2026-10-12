---
subjects:
  - src/application/commands/pull.ts
---
# 946 — Pull refuses divergent branches unless told how to reconcile them, as git does

- **Status:** accepted
- **Date:** 2026-10-06
- **Design:** docs/design/alternates-object-lookup.md · **Supersedes/Refines:** supersedes ADR-198's omission of a rebase mode; refines ADR-226

## Context

A plain `git pull` with no `--rebase` / `--no-rebase` / `--ff-only` and neither `pull.rebase` nor
`pull.ff` configured refuses divergent branches: `fatal: Need to specify how to reconcile divergent
branches.` (a fast-forward still succeeds). `pull.rebase` (`true`, `merges`, `false`, …) and
`--rebase` make pull rebase instead of merging. tsgit's pull always merged, as if `--no-rebase`
were given; ADR-198 had deferred a rebase mode until rebase shipped, and rebase has shipped.

## Options considered

1. **Refuse like git**, and add git's reconcile choices.
2. **Keep the implicit merge**, recording the divergence.

## Decision

**User-ratified — option 1.** `PullOptions` gains `rebase?: boolean | 'merges'` (`false` is
`--no-rebase`, `true` is `--rebase`, `'merges'` is `--rebase=merges`). With no explicit choice, pull
reads `pull.rebase` then `pull.ff` (and `branch.<b>.rebase`) exactly as git does; when nothing chooses
and the branches diverge, pull refuses with a new structured code after the fetch, as git does. A
rebasing pull rebases the current branch onto the fetched head with git's reflog, `ORIG_HEAD` and
refusal semantics.

## Consequences

- Breaking public change (`feat(pull)!`): callers relying on the implicit merge pass `rebase: false`
  (or configure `pull.rebase`); `reports/api.json`, `docs/use/commands/pull.md` updated.
- ADR-198's "omit entirely" is superseded; its other points stand.
- Interop rows: default refusal on divergence, fast-forward still allowed, `pull.rebase` true / merges /
  false, `branch.<b>.rebase`, `--ff-only` interplay — refs, reflogs and commits compared with git.
