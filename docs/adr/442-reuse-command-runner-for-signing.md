# 442 — Reuse CommandRunner for the signing transport

- **Status:** accepted
- **Date:** 2026-07-03
- **Design:** docs/design/gpg-signing.md · **Relates:** ADR-407 (CommandRunner port), ADR-408 (filter-driver primitive)
- **Decision class:** D-architecture (user judgment)

## Context

The backlog item's shorthand ("new port") was written before the `CommandRunner` port
existed. ADR-407 later introduced `CommandRunner` for invoking external programs (LFS
clean/smudge filters, textconv, merge drivers), carrying stdin, captured stdout, and an
exit code, with browser/in-memory adapters falling back inert. Signing a commit, tag, or
push certificate is the same shape: feed a payload on stdin, capture the ASCII-armored
signature on stdout, read the exit code. A dedicated `Signer` port would be a second
abstraction over the same OS-process capability.

## Options considered

1. **Reuse `CommandRunner`** *(user choice)* — a pure signing primitive resolves the
   program (`gpg` / `ssh-keygen` / `gpgsm`) and argv from config, then invokes the
   existing port. No new port; mirrors the filter/textconv/merge-driver precedent
   (ADR-408).
2. **New dedicated `Signer` port** — honor the backlog wording with a distinct
   abstraction. A more explicit, independently mockable seam, at the cost of a second
   port + adapters duplicating `CommandRunner`'s process-exec surface.

## Decision

**Option 1, ratified by the user.** The signer is a pure application primitive
(`sign(payload, opts, ctx)`) that resolves format/program/argv from config and delegates
to `ctx.command` (`CommandRunner`). No new port is introduced; the "new port" backlog
phrasing is satisfied by the pre-existing `CommandRunner`. Off-node behavior (no
`ctx.command`) is governed by ADR-447.

## Consequences

### Positive
- No new port surface; one process-exec abstraction, exercised the same way as the
  filter drivers, keeping the adapter matrix unchanged.
- Testability is preserved — the primitive is pure and `CommandRunner` is already a
  mockable port with a memory fake.

### Negative
- The signer is one of several `CommandRunner` consumers rather than a self-describing
  `Signer` seam; discoverability leans on naming + the design doc.

### Neutral
- No wire or on-disk divergence — this is an internal composition choice.
