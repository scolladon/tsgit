# ADR-219: `cherry-pick` v1 flag set — `-x`, `--allow-empty`, `--no-commit`

## Status

Accepted (at `b4faeceb`)

## Context

`git cherry-pick` has a large flag surface (`-x`, `-n`, `--allow-empty`, `-m`,
`--signoff`, `--edit`, `--ff`, `--keep-redundant-commits`, `--gpg-sign`, …).
Shipping all of it in 22.1 would balloon scope; shipping none would make the
porcelain toy-like. A faithful, useful, bounded subset was needed.

## Decision

v1 ships three flags:

- **`recordOrigin` (`-x`)** — append `(cherry picked from commit <full-oid>)` to
  each message (verified format: blank line + the trailer line).
- **`allowEmpty` (`--allow-empty`)** — a redundant pick (merged tree == HEAD
  tree) creates an empty commit instead of stopping.
- **`noCommit` (`-n`)** — apply each pick to the index + working tree only;
  never commit, never persist `CHERRY_PICK_HEAD`/sequencer state (verified: a
  `-n` conflict leaves markers + unmerged index but no resumable state).

Deferred: `-m`/mainline (ADR-221 rejects merge commits without it), `--signoff`,
`--edit`, `--ff`, `--keep-redundant-commits`, `--gpg-sign`.

## Consequences

### Positive

- Covers the common cherry-pick workflows (provenance, redundant picks, staging
  without committing) with byte-faithful behaviour.

### Negative

- `-m` absence means merge commits cannot be picked at all in v1 (ADR-221).

### Neutral

- `-n` is a distinct code path that bypasses the state machine entirely; it never
  interacts with `continue`/`skip`/`abort` (matches git: a `-n` operation has
  nothing to continue).
