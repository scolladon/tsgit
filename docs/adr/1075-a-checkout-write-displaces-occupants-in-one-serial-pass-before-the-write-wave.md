---
subjects:
  - src/application/primitives/apply-changeset.ts
  - src/application/primitives/internal/symlinked-leading-path.ts
---
# 1075 — A checkout write displaces occupants in one serial pass before the write wave

- **Status:** accepted
- **Date:** 2026-10-25
- **Design:** docs/design/forced-checkout-displace-occupant.md (DC1, P1) · **Supersedes/Refines:** refines ADR-226

## Context

git's `checkout_entry_ca` removes what stands in an entry's way before it writes: a regular file or
symbolic link in a leading path (`create_directories`) and a directory at the entry's own path
(`remove_subtree`). git 2.55 `checkout -f`, `reset --hard` and `checkout -- <path>` succeed on every
such shape. tsgit's `clearOccupants` only clears a directory at an `add` path, and the write paths
never displace a leading regular file, so forced writes throw `NOT_A_DIRECTORY` or
`DIRECTORY_NOT_EMPTY` (design RC1, RC2). The fix must cover four write paths: pooled, one at a
time, streamed and in-core.

## Options considered

1. **Extend the serial `clearOccupants` pre-pass** to every `add` and `update` entry. The leading-path
   scanner learns to name a file obstruction as well as a symlink. Pros: one place for all four write
   paths; it reuses the per-prefix memo, so the clone path gains no syscall; no concurrent `rm` of a
   shared prefix. Cons: one memoised walk plus one `lstat` per `update` entry.
2. **Displace inside each write path** before every write. Pros: local to the writer. Cons: four copies;
   pooled writers race on a shared prefix and would need single-flight.
3. **Displace and retry on the write error.** Pros: no cost on the happy path. Cons: retry logic on
   every writer, and error-driven control flow the adapters map differently.

## Decision

**Adopted as recommended (no user judgment): option 1.** `clearOccupants` runs for every non-lossy
`add` and `update` entry. A leading symlink is left for the write to unlink, as today. A leading
regular file is removed: always when forced, and when unforced only if ignored. Removing it
re-settles the scanner prefix. A directory at a non-gitlink path is cleared under the existing
`every` / `ignored` policy.

## Consequences

- The write paths stay unchanged. `writePhaseOne`'s leading-directory preparation keeps serving the
  links the wave itself creates.
- The proof that the pass is complete enumerates the writers of the work tree during one apply:
  the delete wave, `clearOccupants` and the write wave.
- A case-folding disk stays with the existing fold handling.
