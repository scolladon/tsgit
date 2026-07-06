# ADR-458: push remote resolution & push.default semantics aligned with canonical git

## Status

Accepted (at `69dabf51`)

## Context

`git push` with no `<repository>`/`<refspec>`:

- Selects the **remote** via `branch.<name>.pushRemote ?? remote.pushDefault ??
  branch.<name>.remote ?? origin`.
- Selects and validates the **refspec** via `push.default` (default `simple`): `simple`
  and `upstream` require `branch.<name>.merge` (a configured upstream) and — for `simple`
  — that the upstream branch name matches, refusing otherwise (*"The current branch <b>
  has no upstream branch"*); a detached HEAD without an explicit refspec refuses (*"not
  currently on a branch"*).

tsgit's `push` resolves only `opts.remote ?? 'origin'`, pushes the current-branch refspec,
and implements **none** of `push.default` / `pushRemote` / `pushDefault` / upstream-refusal —
several divergences from canonical git (prime directive, ADR-226).

`ParsedConfig` already models `branch.<name>.merge`; it does **not** model
`branch.<name>.pushRemote`, `remote.pushDefault`, or `push.default`.

Verified against real git 2.55.0 (scrubbed `GIT_*`): `pushRemote` > `pushDefault` >
`branch.remote` for remote selection; `simple` refuses without a configured upstream;
detached HEAD refuses without an explicit refspec.

## Decision

Implement git-faithful `push` (ratified user judgment, chosen with the probe evidence in hand):

1. **Config infra** — parse `branch.<name>.pushRemote` (into the branch entry),
   `remote.pushDefault` (top-level `[remote] pushDefault`), and `push.default`
   (`[push] default`; enum `nothing|current|upstream|simple|matching`, default `simple`).
2. **Remote selection** — `opts.remote ?? branch.<current>.pushRemote ?? remote.pushDefault ??
   branch.<current>.remote ?? DEFAULT_REMOTE`; detached ⇒ `remote.pushDefault ?? DEFAULT_REMOTE`
   (no `branch.*`). Shares the `defaultRemoteName` family (ADR-456) where the chain overlaps.
3. **Refspec + refusal per `push.default` mode** (when no explicit refspec) — implement
   `simple` / `current` / `upstream` / `matching` / `nothing`, including the upstream-required
   refusals (`simple`/`upstream` without `branch.<name>.merge`; `simple` name-mismatch) and the
   detached-HEAD refusal. Error **data** (code + message shape) is part of the parity.
4. **Interop matrix** — pin byte-for-byte against real git across
   {`pushRemote`, `pushDefault`, `branch.remote`, `branch.merge` set/unset} ×
   `push.default` ∈ {`simple`,`current`,`upstream`,`matching`,`nothing`} ×
   {explicit remote/refspec vs none} × {symbolic / detached HEAD}. Refusal *conditions*, not
   only success paths, are pinned.

## Consequences

### Positive

- `push` becomes git-faithful for remote selection and refspec/refusal; closes several
  prime-directive divergences.

### Negative

- Large surface — new config keys, a `push.default` state machine, a refusal matrix, and a
  sizeable interop suite. Blast radius well beyond backlog 26.2's refactor.

### Neutral

- `push.default` `matching` (all same-named branches) and triangular edge cases are pinned by
  interop rather than hand-modeled. `remote.pushDefault` is the only top-level `[remote]` scalar
  key added.
