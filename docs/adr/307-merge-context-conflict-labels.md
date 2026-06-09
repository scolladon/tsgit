# ADR-307: Merge-context conflict-marker & driver labels (combine 24.9b + 24.9e)

## Status

Accepted (at `<sha-after-merge>`)

## Context

git derives the strings it writes after conflict markers (`<<<<<<< HEAD`,
`>>>>>>> feature`) from the operation context, and passes the **same** strings to
an external merge driver as `%X` (ours), `%Y` (theirs), and `%S` (base). tsgit:

- hardcodes `ours` / `theirs` on the built-in markers (gap tracked as 24.9e), and
- emits `%S` / `%X` / `%Y` **literally** (unsubstituted) to drivers (gap 24.9b).

These were separate backlog items, but the label *value* is identical between the
two surfaces — both come from one per-operation computation. Implementing them
apart would build (and test) that computation twice, and shipping 24.9b's
`%X`/`%Y` faithfully is impossible without the very label computation 24.9e needs.

The label strings (verified against git 2.54.0):

| operation    | `%S` (base)                   | `%X` (ours)        | `%Y` (theirs)                 |
|--------------|-------------------------------|--------------------|-------------------------------|
| merge        | `<merge-base-abbrev>`         | `HEAD`             | `<rev-as-typed>`              |
| cherry-pick  | `parent of <abbrev> (<subj>)` | `HEAD`             | `<abbrev> (<subj>)`           |
| revert       | `<abbrev> (<subj>)`           | `HEAD`             | `parent of <abbrev> (<subj>)` |
| rebase       | `parent of <abbrev> (<subj>)` | `HEAD`             | `<abbrev> (<subj>)`           |
| stash        | `Stash base`                  | `Updated upstream` | `Stashed changes`             |

`<subj>` is git's `find_commit_subject` (first body line, verbatim);
`<rev-as-typed>` is the merge argument unnormalised; the base label feeds the
driver `%S` only (tsgit writes no diff3 base marker in v1).

## Decision

Ship the label computation **once**, in a pure `domain/merge/merge-labels.ts`
(`MergeLabels = { ours, theirs, base }` + per-operation builders), and thread it
to **both** surfaces: the built-in `writeConflictMarkers` (`ours`/`theirs`) and
the driver placeholders (`%X`/`%Y`/`%S`). This closes 24.9b and 24.9e together.

Labels are a per-operation constant computed by each command (which holds the
oids/rev-name and reads the commit for its subject) and passed into
`buildContentMerger`; the size is per-path (an attribute) resolved inside it.

**Abbreviation is fixed at 7 chars**, per the project-wide **ADR-169** policy (no
object-DB walk to auto-extend) and the existing `stash` precedent
(`base.b.slice(0, 7)`). git's dynamic abbreviation is 7 on the small interop
repos, so this is byte-faithful there; it diverges only on very large histories —
the accepted ADR-169 wart, not a new one.

## Consequences

### Positive

- One label computation, two consumers — DRY; the built-in markers and the driver
  `%X`/`%Y`/`%S` can never drift apart.
- Faithful conflict-marker bytes and driver placeholders across all five
  operations.
- `abbreviateOid` is shared with `stash` (architecture step), removing its inline
  `slice(0, 7)`.

### Negative

- Larger blast radius than either item alone: `buildContentMerger` /
  `apply-merge-to-worktree` gain a `labels` parameter, and every consumer
  (`merge`/`cherry-pick`/`revert`/`rebase`/`stash`) computes and threads it. The
  rebase `mergeUnderLock` gains the source-commit oid.

### Neutral

- The base label (`%S`) is driver-only until v1 grows diff3 markers; for merge it
  is the single merge base's abbrev (criss-cross/recursive "merged common
  ancestors" remains a separate existing limitation).
- The merge their-label is the rev argument verbatim (git does not normalise
  `refs/heads/…`), so it follows tsgit's `opts.rev` directly.
