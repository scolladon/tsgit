# ADR-230: `repo.rebase.{run,continue,skip,abort}` namespace + `run` input

## Status

Accepted (at `06489642`)

## Context

`rebase` is a multi-verb porcelain like `cherry-pick`/`revert`: the rebase itself
plus the in-progress verbs `--continue`/`--skip`/`--abort`. ADR-181/192/193/210
established the **frozen, non-callable nested namespace** as the surface for every
post-ADR-181 multi-verb porcelain (`stash`, `cherryPick`, `revert`, …), and
ADR-217 named the primary verb `run`. The remaining question is the `run` input
shape: how `upstream` and the `--onto <newbase>` redirect are expressed.

## Decision

Ship a frozen nested namespace `repo.rebase` with verbs `run` / `continue` /
`skip` / `abort`, bound via `bindRebaseNamespace(ctx, guard)` mirroring
`bindCherryPickNamespace`. `run` takes:

```ts
interface RebaseRunInput { readonly upstream: string; readonly onto?: string; }
```

`upstream` is the fork-point side (positional `git rebase <upstream>`); `onto`
is the optional `--onto <newbase>` redirect, defaulting to `upstream`. Both are
commit-ish strings resolved through the existing `resolveCommitIsh` ladder.

`run`/`continue`/`skip` return `RebaseResult` (`rebased` | `up-to-date` |
`conflict`); `abort` returns `RebaseAbortResult` (`{ head, headName }`).

## Consequences

### Positive

- Identical idiom to the four sibling history-rewrite namespaces; one binding
  pattern; the verb group reads cohesively.

### Negative

- A sixth nested namespace to maintain.

### Neutral

- `run({ upstream, onto })` keeps the positional/flag distinction of the CLI in
  named-field form, matching how `cherryPick.run({ commits })` mirrors its CLI.
