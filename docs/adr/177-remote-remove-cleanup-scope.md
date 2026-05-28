# ADR-177: `remote remove` deletes config, tracking refs, and branch referrers

## Status

Proposed

## Context

Canonical `git remote remove <name>` does three things in one step:

1. Drops the `[remote "<name>"]` section from `.git/config`.
2. Deletes every ref under `refs/remotes/<name>/*`.
3. Clears `branch.<X>.remote` and `branch.<X>.merge` for any local
   branch whose `remote` named the removed one.

The tsgit Phase 20.5 question is how much of that we mirror, and in
what order. The two failure modes worth thinking about:

- Mid-flight failure leaves some artefacts but not others. Which
  ordering produces the most recoverable state?
- Packed-only tracking refs. Canonical git rewrites `packed-refs` to
  drop the entries; tsgit's `updateRef` delete path explicitly does
  not (`unsupportedOperation` on a packed-only delete — see
  `src/application/primitives/update-ref.ts:59`).

## Decision

`remote remove` does all three cleanup steps (config block, tracking
refs, branch referrers) in this order:

1. **Enumerate** the tracking refs and the branch referrers from the
   parsed config — read-only, no mutation yet.
2. **Delete tracking refs first.** Each deletion goes through
   `updateRef(ctx, name, ZERO_OID, { delete: true })`, which already
   cleans up the reflog. A packed-only tracking ref surfaces
   `UNSUPPORTED_OPERATION` — the caller can `git pack-refs --unpack`
   and retry.
3. **Rewrite config second.** A single batch (`updateConfigOperations`)
   removes the `[remote "<name>"]` section and clears every paired
   `branch.<X>.remote` / `branch.<X>.merge` key. The batch is one
   `writeUtf8` call — internally atomic via the existing
   line-surgery path.

The recoverable mid-flight states:

- **Crash between steps 1 and 2** — nothing touched, re-run is a clean
  retry.
- **Crash between steps 2 and 3** — tracking refs partially gone, config
  intact. Re-running `remove` is safe: step 1 enumerates the residual
  refs, step 2 deletes the rest, step 3 rewrites the config.
- **Crash mid-step 3** — `writeUtf8` is atomic on the FileSystem port
  (rename-into-place); either the new config is in place or the old
  one is.

## Consequences

### Positive

- **Canonical-git parity.** Same three-fold cleanup with the same
  semantics. The reflog cleanup falls out of `updateRef`'s existing
  delete path.
- **Recoverable.** Every failure point reduces to "re-run `remove`,
  it picks up from where it left off."
- **Branch referrers cleaned.** Without this, a user who removes a
  remote and creates a new branch named the same as a deleted one
  would inherit dangling `remote = <old>` / `merge = …` config — a
  bug canonical git fixes by clearing the keys.

### Negative

- **Packed-only tracking refs require manual unpacking.** Canonical
  git would rewrite `packed-refs` to drop them. tsgit's
  `update-ref` machinery doesn't support packed-only delete in v1.
  Mitigation: surface `UNSUPPORTED_OPERATION` with a clear reason
  string. A future ADR can land `pack-refs --unpack` parity if a
  real user hits the wall.
- **The whole `[branch "X"]` section is kept.** We clear only the
  `remote` and `merge` keys, leaving the header line. Canonical git
  matches this; the alternative (delete the whole section) would lose
  user-set keys like `branch.<X>.description`.

### Neutral

- **Atomicity.** The two write steps (delete refs, rewrite config)
  are not transactional. Per the existing project invariant
  (per-`Context` single-threaded `repo.*` calls), no other writer
  can race in between within one process. Multi-process or external
  `git` running concurrently would race today regardless of what
  20.5 does.

## Alternatives considered

- **Config first, refs second** — rejected. A mid-flight failure
  leaves orphan tracking refs with no way for `remove`'s re-run to
  enumerate them (the config block is gone). Re-running would
  succeed without cleaning up the residue, leaving dangling refs.
- **Single-step "atomic" rewrite via a temp directory** — rejected.
  Overkill for this surface; the per-step atomicity (file rename,
  ref atomic-write) already covers the realistic failure modes,
  and the temp-directory dance would mostly serve as a placebo
  against the same multi-process race we cannot prevent anyway.
- **Silently ignore packed-only refs** — rejected. The user wants
  the remote *gone*; silently leaving entries in `packed-refs`
  contradicts the verb. Surface the limitation explicitly.
