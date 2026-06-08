# ADR-292: `submodule add` implements `--branch` (track a named branch)

## Status

Accepted (at `6adba128c25b`)

## Context

`git submodule add -b <branch> <url> <path>` pins a branch: it records
`branch = <branch>` in `.gitmodules` and checks the submodule out on that branch
rather than the remote's default HEAD. Verified against git 2.54, `add -b dev`:

- `.gitmodules` → `[submodule "<name>"]` with `path`, `url`, then `branch = dev`.
- the module is left on **`refs/heads/dev`** (not detached), at `origin/dev`.
- the module gitdir carries **both** local branches: `main` (from the clone's
  default checkout) **and** `dev` (created by the subsequent checkout), each with
  `branch.<b>.remote=origin` / `merge=refs/heads/<b>`.
- the gitlink staged is `dev`'s commit; the superproject `.git/config` is unchanged
  (`url`, `active` — no `branch` key; the branch lives only in `.gitmodules`).

tsgit's `checkout` has no DWIM remote-tracking branch creation (its switch mode
requires the local branch ref to pre-exist), so `-b` needs explicit branch
creation. The alternative considered was omitting `--branch` (default to remote
HEAD).

## Decision

Implement `add({ url, path, name?, branch? })`. When `branch` is set, after
`clone(child)` (which checks out the remote HEAD branch, e.g. `main`):

1. create the local tracking branch `refs/heads/<branch>` at `origin/<branch>`'s
   oid, writing `branch.<branch>.remote=origin` / `merge=refs/heads/<branch>` to
   the module config;
2. `checkout(child, { rev: <branch> })` — switches HEAD to the branch + reflog
   `checkout: moving from main to <branch>` + materialises its tree;
3. append `branch = <branch>` to the `.gitmodules` entry (after `path`, `url`);
4. stage `<branch>`'s commit as the gitlink.

Without `branch`, `add` checks out the remote HEAD branch via
`materializeWorktreeFromHead` (ADR-289) and writes no `branch` key — git's no-`-b`
behaviour. `--reference`/`--depth` shallow submodules stay out of scope.

## Consequences

### Positive

- Byte-faithful to `git submodule add -b`, including the dual-branch module config
  and the branch-only-in-`.gitmodules` placement.

### Negative

- Adds branch-creation + tracking-config logic the submodule layer owns (a small,
  focused helper); justified by the explicit `-b` requirement.

### Neutral

- The created-tracking-branch helper is submodule-local; if a second consumer
  appears it can be promoted, but it is not generalised speculatively.
