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
