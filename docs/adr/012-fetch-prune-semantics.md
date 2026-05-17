# ADR-012: Prune Scoped To `refs/remotes/<remote>/*` Only

## Status

Accepted (at `22f0594`)

## Context

`FetchOptions.prune?: boolean` has existed on the public type since the
Phase 9 fetch stub. Phase 12.2 needs to decide its semantics.

Canonical `git fetch --prune`:
- Deletes any `refs/remotes/<remote>/<branch>` whose `<branch>` is no longer
  advertised by the remote.
- Optionally also deletes tags (`git fetch --prune --prune-tags`).
- Never deletes local branches (`refs/heads/*`).

Three policy questions for tsgit:

**Q1 — Does prune touch local branches?**

No, never. Local branches belong to the user. A fetch that silently
deletes `refs/heads/feature` because the remote dropped its remote
counterpart would lose user work. Canonical git agrees.

**Q2 — Does prune touch tags?**

Canonical git's `--prune` flag does NOT touch tags by default; a separate
`--prune-tags` flag is required. Tags are conceptually immutable, so
auto-removing them on a remote-driven trigger feels wrong.

Phase 12.2 takes the conservative path: `prune: true` deletes only
`refs/remotes/<remote>/<branch>` refs, never tags. A future
`pruneTags: boolean` option could enable the analogous behavior — but it
is NOT added in this phase. The `prune` boolean stays a single flag.

**Q3 — What is the "scope of comparison"?**

The set of refs the server advertised. If the server's advertisement is
filtered (e.g., a `--single-branch` clone), the comparison should be
against only the requested refspecs. Phase 12.2 hardcodes the default
refspec `+refs/heads/*:refs/remotes/<remote>/*`, so the scope is "every
branch the server advertised at this fetch".

## Decision

`FetchOptions.prune === true` causes fetch to:

1. List loose refs under `refs/remotes/<remote>/` after applying server-side
   advertisement.
2. For each on-disk ref whose `<branch>` portion is NOT in the server's
   advertised refs (under `refs/heads/`), call `updateRef(name, ..., { delete: true })`.
3. Collect the deleted ref names into `result.prunedRefs`.

`prune: false` (or unset) leaves stale remote-tracking refs untouched.

Local branches (`refs/heads/*`), local tags (`refs/tags/*`), and refs
outside `refs/remotes/<remote>/*` are NEVER touched by prune, regardless
of the flag.

Tags are not auto-pruned. The `--prune-tags` analogue is deferred.

## Consequences

### Positive

- Conservative default: a user who turns on prune cannot accidentally lose
  local work.
- Behavior matches canonical `git fetch --prune` for the common case
  (remote-tracking branch cleanup).
- The `prunedRefs` array gives callers programmatic visibility into the
  cleanup action.

### Negative

- A user who wants tag pruning today has to manually call `tag --delete`
  or write a custom command. v1 takes that hit; a `pruneTags` option can
  land in a v1.x patch.
- Listing the directory `refs/remotes/<remote>/` adds one filesystem
  enumeration per fetch when `prune` is on. Cost is negligible for typical
  repos (low-dozens of branches).

### Neutral

- The packed-refs reader path is not exercised by prune in v1.0 — only
  loose refs under `refs/remotes/<remote>/` are scanned. A packed-refs
  rewrite to remove pruned entries is deferred (matches the
  `unsupportedOperation('delete-packed-ref', ...)` posture in
  `updateRef`). If a remote-tracking ref is in `packed-refs` and the
  server stops advertising it, prune surfaces an `UNSUPPORTED_OPERATION`
  error rather than silently doing nothing.
