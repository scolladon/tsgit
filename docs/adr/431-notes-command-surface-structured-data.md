# 431 — notes command surface returns structured data

- **Status:** accepted
- **Date:** 2026-06-28
- **Design:** docs/design/notes.md · **Relates:** ADR-249 (structured data only), ADR-226 (git-faithfulness)
- **Decision class:** D-API

## Context

`notes` is a new Tier-1 family `repo.notes.*` mirroring git's `notes add/show/list/remove`
over `refs/notes/*`. The on-disk mechanics (tree, commit, ref, reflog) are the library's to
own byte-for-byte; the rendering of note text is the caller's (ADR-249). That leaves a cluster
of public-surface shape questions the library author owns — verb naming, what `read` returns,
how `add` signals overwrite, and the note-content type at the boundary.

## Options considered

**Verb naming** — (1) `add`/`read`/`list`/`remove`, `read` over git's porcelain `show` *(rec)*;
(2) mirror git porcelain `show`. Data-oriented naming matches tsgit's structured-output stance.

**`read` on an absent note** — (1) return `null` *(rec)* — a query reports absence, mirrors
`bisect`'s `undefined` precedent; (2) throw — turns a normal "no note" into an exception.
`remove` on an absent note stays a refusal (it is a mutation; CQS asymmetry is intentional).

**`read` return** — (1) inline bytes `{ object, note, content }` *(rec)* — saves a round-trip,
precedent: `archive` returns blob bytes; (2) oid-only — caller re-reads the blob itself.

**`add` overwrite signal** — (1) boolean `force` *(rec)* — `append` is a distinct git verb,
out of scope; (2) mode enum `fail`/`overwrite`/`append` — implies append support we do not ship.

**Note content type** — (1) `Uint8Array` *(rec)* — binary-faithful blob boundary; text
normalization (trailing newline, `-m` join, stripspace) is porcelain, pushed to the caller per
ADR-249; (2) `string` — bakes an encoding + normalization policy into the data surface.

## Decision

The public surface is:

- `repo.notes.add({ object, content, force?, ref? }) → { notesCommit, note }`
- `repo.notes.read({ object, ref? }) → { object, note, content } | null`  (`content: Uint8Array`)
- `repo.notes.list({ ref? }) → ReadonlyArray<{ object, note }>`  (git tree order)
- `repo.notes.remove({ object, ref? }) → { notesCommit }`

`content` crosses the boundary as raw `Uint8Array` and is stored as the blob **verbatim** — the
library never appends a trailing newline or runs stripspace (a documented non-goal: `git notes
add -m ""` is a porcelain *removal* via stripspace; the library stores an empty blob instead).
Error codes are structured and specific: `NOTES_ALREADY_EXIST` (add over an existing note
without `force`), `NOTES_OBJECT_HAS_NONE` (remove with no note present). No rendered string
crosses the boundary; an interop test reconstructs git's `notes show`/`notes list` stdout from
these fields and compares to real `git`.

Naming/`read`-absent/`read`-inline ratified by the user as recommended; force-boolean and
`Uint8Array` adopted as recommended (no user judgment — they follow ADR-249 and existing
precedent directly).

## Consequences

- One ergonomic, ADR-249-clean surface; oids/bytes cross the boundary, never a formatted line.
- `null` keeps the common "no note here" query out of the exception path; mutation absences stay
  refusals (CQS).
- Storing `content` verbatim means the caller owns git's `-m` normalization — the faithful split
  for a data library; the interop test feeds pre-normalized bytes to compare blob SHAs.
- `ref?` per verb is wired to the notes-ref selection rule in [ADR-433](433-notes-ref-selection-and-git-notes-ref-env.md).
