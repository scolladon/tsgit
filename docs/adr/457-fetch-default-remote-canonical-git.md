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
`git fetch` fetches from `upstream`; unset, it fetches from `origin`.

## Decision

Make `fetch` tracking-aware, reusing `defaultRemoteName` (ADR-456):
`opts.remote ?? branch.<current>.remote ?? DEFAULT_REMOTE`. Detached HEAD (no current
branch) ⇒ `DEFAULT_REMOTE`.

Pin byte-for-byte with a `fetch`-interop case (twin git/tsgit) across
{`branch.remote` set/unset} × {explicit remote / none} × {symbolic / detached HEAD}.

Ratified user judgment (correcting a prior divergence).

## Consequences

### Positive

- git-faithful; shares the tracking-aware chain with `pull` and `submodule`.

### Negative

- Behavior change — a repo with `branch.<name>.remote` set now fetches that remote instead of `origin`.

### Neutral

- `pull` already resolved this correctly; `fetch` now matches it and git.
