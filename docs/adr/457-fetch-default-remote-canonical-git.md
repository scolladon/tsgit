# ADR-457: fetch default-remote resolution aligned with canonical git

## Status

Accepted (at `69dabf51`)

## Context

`git fetch` with no `<repository>` uses the current branch's configured remote —
`branch.<name>.remote`, falling back to `origin`. tsgit's `fetch` resolves
`opts.remote ?? 'origin'`, **ignoring `branch.<name>.remote`** — a divergence from
canonical git (prime directive, ADR-226). `ParsedConfig` already exposes
`branch.<name>.remote`.

Verified against real git 2.55.0 (scrubbed `GIT_*`): with `branch.main.remote=upstream`,
`git fetch` fetches from `upstream`; unset, it fetches from `origin`. Git also has a
**single-remote special case** — with exactly one configured remote (any name) and no
`branch.<name>.remote`, `git fetch` uses that sole remote, not `origin` (probed: a lone
remote named `solo` ⇒ `git fetch` fetches `solo`).

## Decision

Make `fetch` tracking-aware, reusing `defaultRemoteName` (ADR-456). The faithful
resolution is `opts.remote ?? branch.<current>.remote ?? <sole remote if exactly one> ??
DEFAULT_REMOTE`; detached HEAD (no current branch) skips the `branch.*` step. The
sole-remote fallback (ratified user judgment) is folded into `defaultRemoteName`, so it
applies uniformly to `fetch`, `pull`, and `push`'s terminal fallback — `pull` (which
already resolved `branch.remote ?? origin`) thereby also becomes fully faithful and joins
the behavior-changed set.

Pin byte-for-byte with `fetch`-interop cases (twin git/tsgit) across
{`branch.remote` set/unset} × {0/1/2 remotes} × {explicit remote / none} ×
{symbolic / detached HEAD}.

Ratified user judgment (correcting a prior divergence).

## Consequences

### Positive

- git-faithful; shares the tracking-aware chain with `pull` and `submodule`.

### Negative

- Behavior change — a repo with `branch.<name>.remote` set now fetches that remote instead
  of `origin`; a repo with a single non-`origin` remote now fetches that remote from both
  `fetch` and `pull`.

### Neutral

- `pull` already resolved `branch.remote`; the sole-remote fallback now makes both `pull`
  and `fetch` match git exactly.
