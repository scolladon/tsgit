# ADR-462: `name-rev` cutoff target date via one up-front object read

## Status

Accepted (2026-07-09)

## Context

The cutoff is derived from the TARGET commit's committer timestamp
(`cutoff = targetDate − 86400`), and must be known before the ref flood
begins. `nameRev` resolves the target through `resolveCommit`, which peels
tags to a commit oid but returns only the `ObjectId` — the commit object
(and its `data.committer.timestamp`) is not in hand.

## Decision

`nameRev` reads the target commit once at the top of the command
(`readObject(ctx, target)`), takes `data.committer.timestamp`, computes the
cutoff, then runs the existing walk. `resolveCommit` is untouched. Because
`resolveCommit` peels to `'commit'` and refuses otherwise, the read is
guaranteed to return a commit object — no runtime type-guard is added (it
would be an untestable dead branch).

## Consequences

- One extra object read per `nameRev` call; the target is on the walk's hot
  path anyway, so the read is typically cache-warm.
- Localised and explicit; no signature change ripples to the many other
  `resolveCommit` callers.
- The cutoff uses the dereferenced commit's committer date — never an
  annotated tag's tagger date (which only enters the selection tie-break).

## Alternatives considered

- **Extend `resolveCommit` to return `{ oid, commit }`** — wider blast
  radius across every consumer for one caller's convenience (feature envy).
- **Derive the date during the walk** — circular: the cutoff must exist
  before the walk in order to prune it.
