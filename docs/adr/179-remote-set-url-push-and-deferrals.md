# ADR-179: `remote setUrl` writes `pushurl` for `push: true`; `--add` and `--delete` deferred

## Status

Proposed

## Context

`git remote set-url` has four flag modes:

- default (no flag) — replaces `remote.<name>.url`.
- `--push` — replaces `remote.<name>.pushurl` (fall-back to `url`
  when reading; `push` consumes `pushurl ?? url`).
- `--add` — adds an additional URL to the same key (canonical git
  supports multiple `url =` entries per remote — a pseudo
  load-balancer; `fetch`/`push` picks one).
- `--delete` — removes URLs matching a glob.

tsgit's Phase 20.5 has to pick which of these to ship in v1.

Multi-URL remotes are rare in practice (HA mirroring on the smart-
HTTP backend is the canonical user). Today's tsgit transport reads a
single URL per remote — supporting `--add` / `--delete` would force
the transport layer to grow a URL-fail-over story we have not
designed.

## Decision

`setUrl({ name, url })` writes `remote.<name>.url`. `setUrl({ name,
url, push: true })` writes `remote.<name>.pushurl`. The two keys
coexist and replace any prior value byte-for-byte.

`--add` and `--delete` are explicitly out of scope for 20.5. The
20.5 `setUrl` is a single-URL *replacer*, not a list mutator.

`push.ts` is extended in this same PR to read
`remote.<name>.pushurl ?? remote.<name>.url` so the new write path
actually changes behaviour. Without that, `setUrl({ push: true })`
would silently no-op for `push`.

## Consequences

### Positive

- **Canonical-git parity for the common path.** `set-url` and
  `set-url --push` are the two flags 99% of users actually use.
- **`push` honours `pushurl`.** A workflow where the user fetches
  from `https://github.com/org/repo` but pushes through
  `git@github.com:org/repo.git` works today.
- **Surface stays narrow.** Two boolean states (`push?: true`) cover
  the common cases without dragging multi-URL transport semantics
  into 20.5.

### Negative

- **`set-url --add` not available.** A user who wanted to add a
  failover URL has to edit `.git/config` by hand (the existing
  `repo.primitives.recordRefUpdate`-style escape hatch). Acceptable
  — multi-URL remotes are an HA-mirroring feature; tsgit's transport
  does not pick across them today, so the gap is bigger than just
  the verb.
- **No URL validation beyond control-char rejection.** Same trade-off
  as `add` (ADR-176). The first `fetch`/`push` surfaces a bad URL.

### Neutral

- The decision is reversible: a follow-up phase can land `setUrl({
  push: true, add: true })` and matching transport-layer fail-over
  without changing the existing single-URL signature (the new
  options would be additive on the action shape).

## Alternatives considered

- **Ship `--add` and `--delete` in 20.5** — rejected. They require
  the transport layer to grow a URL-list iteration story (which
  URL gets tried first, what is the fail-over policy, do we retry
  with the next URL on network error). That is a transport-layer
  design conversation, not a porcelain CRUD one. Deferring keeps
  20.5 scoped.
- **Reject `push: true` and tell users to write `pushurl` via a
  primitive** — rejected. `setUrl` is the verb users know from
  canonical git, and `--push` is its second-most-common flag. Not
  shipping it would force every workflow that uses a separate push
  URL through a `setConfigEntry` primitive call.
