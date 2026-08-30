# ADR-743: Reflog expire always rewrites

## Status

Accepted (at `fc54f8cd`) — adopted-as-recommended (no user judgment)

## Context

git's `reflog expire` always rewrites the log file — even `--expire=never`, which
expires nothing, purges malformed lines (measured; a clean file rewrites
byte-identically). tsgit's `runExpire` writes only when
`survivors.length !== stored.length`, two *parsed* counts: once the read is
lenient, a file whose only defect is a malformed line yields equal counts and no
write — the corruption stays on disk where git purges it. Leniency alone would
make the command less faithful. Alternatives: a `{ entries, skippedLines }` return
on the seam verb driving a conditional write; or comparing survivors against the
raw on-disk line count.

## Decision

`runExpire` rewrites unconditionally, matching git. The implementation must
confirm the reflog replace write is atomic (git locks and renames;
`applyReflogReplace` currently uses `ctx.fs.writeUtf8`) before making it an
every-run write.

## Consequences

### Positive

- Simplest faithful shape; the purge behaviour needs no extra plumbing.

### Negative

- One write per target per run (one per reflog under `--all`), even when nothing
  changed.

### Neutral

- Byte-identical rewrites are unobservable in content; only timestamps/inodes
  move.
