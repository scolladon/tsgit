---
subjects:
  - src/application/primitives/sign-payload.ts
  - src/application/commands/archive.ts
---
# 935 — Signature verification stages the detached signature under the git dir

- **Status:** accepted
- **Date:** 2026-10-01
- **Design:** docs/design/alternates-object-lookup.md (DC-22) · **Supersedes/Refines:** refines ADR-442, ADR-933

## Context

`%G*` placeholders need `gpg`/`ssh-keygen` to verify a detached signature read from a file;
git writes it to a `$TMPDIR` temp file. tsgit's `FileSystem` is repo-rooted and has no temp port.
SSH signing already stages its buffer under the git dir (`sign-payload.ts`).

## Options considered

1. **Transient file under the git dir, removed in `finally`** — the SSH-signing precedent (recommended).
2. **Adapter-owned temp file via a `CommandRunner` capability** — cons: a port change for one caller.
3. **No verification** — cons: wrong `%G?` bytes for every signed commit.

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** `archive` gains a `@writes` entry for
the transient file; it exists only while verification runs.

## Consequences

- Off Node (no `CommandRunner`), `%G*` yields git's cannot-exec outcome.

## Amendment — staging location diverges from git (2026-10-07)

The staged files bear git's names (`.git_vtag_tmpXXXXXX` for verification,
`.git_signing_buffer_tmpXXXXXX` for SSH signing), but not git's location. git creates both with
`mks_tempfile_t`, under `$TMPDIR`; tsgit creates them under the git dir.

- **Observable divergence:** with a read-only `.git`, `git verify-commit` (and `%G?` in
  `git archive`) still verifies, because nothing is written to the repository. tsgit cannot stage
  the signature, so the verification refuses. SSH signing diverges the same way.
- **Why:** containment. The `FileSystem` port is rooted at the repository, and tsgit writes
  nothing outside the repository unless the caller supplies the file system that reaches there.
  Staging in `$TMPDIR` needs a temp-file capability (option 2) and the caller's sign-off; until
  then the divergence stands.
- **Mode:** git creates the file `0600`. The port's exclusive write carries no mode, so tsgit's
  file takes the file system's default mode.
