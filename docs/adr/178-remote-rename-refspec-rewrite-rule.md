# ADR-178: `remote rename` conservatively rewrites the canonical refspec only

## Status

Proposed

## Context

`git remote rename <from> <to>` does four kinds of rewrite in one step:

1. The `[remote "<from>"]` section header becomes `[remote "<to>"]`.
2. The default fetch refspec
   `+refs/heads/*:refs/remotes/<from>/*` becomes
   `+refs/heads/*:refs/remotes/<to>/*`.
3. Tracking refs under `refs/remotes/<from>/*` move to
   `refs/remotes/<to>/*`.
4. `branch.<X>.remote = <from>` becomes `branch.<X>.remote = <to>`
   for every branch that named the renamed remote.

The fetch-refspec rewrite is the subtle one. Canonical git rewrites
*only* the refspec that exactly matches the canonical
`+refs/heads/*:refs/remotes/<from>/*` form. Any custom refspec the
user wrote is left untouched.

Two reasonable alternatives:

- **A: rewrite every refspec that mentions the old remote name in its
  destination** — including custom variants like
  `+refs/heads/release:refs/remotes/<from>/release`.
- **B: rewrite only the exact canonical form.** Custom refspecs stay
  verbatim.

The two routes also have to handle multi-refspec remotes (canonical
git supports multiple `fetch =` lines).

## Decision

`rename` rewrites **only the exact canonical refspec**
`+refs/heads/*:refs/remotes/<from>/*`. Every other refspec in the
section is preserved verbatim, including in lists where one entry is
canonical and others are custom. This matches `git`'s implementation
(`builtin/remote.c::migrate_file`).

Tracking refs move regardless of refspec content: `rename` enumerates
every ref under `refs/remotes/<from>/*` (loose) and moves them to
`refs/remotes/<to>/*`. A packed-only ref surfaces
`UNSUPPORTED_OPERATION`, mirroring the `remove` rule from ADR-177.

`branch.<X>.pushRemote` is **not** rewritten in this phase. tsgit
v1 has no consumer of `pushRemote` (only `branch.<X>.remote` is read
by `push`), so a rewrite would be premature. A follow-up ADR can
revisit when a real consumer ships.

## Consequences

### Positive

- **Canonical-git parity** for the refspec rule. Users moving back
  and forth between `git` and `tsgit` get identical behaviour.
- **Custom refspecs are safe.** A user who hand-edited a refspec to
  do something unusual (selective tag mirror, scoped namespace,
  forbidding a branch) doesn't lose their intent on `rename`.
- **Multi-refspec remotes work.** A remote with one canonical entry
  and one custom entry comes out with the canonical entry rewritten
  and the custom one verbatim — matching what canonical git does.

### Negative

- **A user with a "slightly off" canonical form** — e.g.
  `+refs/heads/*:refs/remotes/<from>/*` without the leading `+`, or
  `refs/heads/main:refs/remotes/<from>/main` — does not get the
  rewrite. Their custom refspec stays pointing at the old name, and
  the next `fetch` will write under the old name. Mitigation: the
  20.5 design doc spells this out, and canonical git has the same
  edge case (users live with it).
- **Packed-only tracking ref surfaces an error.** Same as ADR-177.
  Manual `pack-refs --unpack` + retry.

### Neutral

- The `from === to` case is rejected at the surface with
  `INVALID_OPTION`. Canonical git accepts it as a no-op; we reject
  to surface what is almost certainly a caller bug.

## Alternatives considered

- **A (rewrite anything that mentions `<from>` in the destination)** —
  rejected. The rule is hard to specify ("destination" within a
  refspec is parser knowledge that lives in `parseRefspec`; the
  config-write surface doesn't know it). Worse, the heuristic
  would silently rewrite custom refspecs the user did not want
  touched. Canonical git's conservative rule is the right one.
- **C (rewrite the section header but not the refspec)** — rejected.
  Leaves the canonical refspec pointing at the old name; subsequent
  `fetch` writes under `refs/remotes/<from>/*` after `rename`
  ostensibly moved everything. Inconsistent.
