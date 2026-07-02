# 441 — OpenSSH-only argv; ssh-variant detection deferred

- **Status:** accepted
- **Date:** 2026-07-02
- **Design:** docs/design/ssh-transport.md · **Relates:** ADR-226 (git-faithfulness — explicit divergence), ADR-435 (argv construction)
- **Decision class:** D-scope (user judgment)

## Context

Canonical git auto-detects the SSH *variant* from the resolved command's basename and
the `ssh.variant` config (`ssh`/`simple`/`plink`/`putty`/`tortoiseplink`), changing
argv per variant — OpenSSH uses `-p <port>`, PuTTY's plink uses `-P <port>`,
tortoiseplink additionally gets `-batch`. Replicating this is a sizeable,
mostly-Windows-PuTTY test matrix. The prime directive (ADR-226) allows divergence
only through an explicit ADR that says why — this is that ADR.

## Options considered

1. **OpenSSH-only now** *(user choice)* — build OpenSSH-style argv (`-p` for port);
   defer the variant table to its own backlog item.
2. **Full variant detection now** — faithful from day one, but the surface is large,
   requires per-variant interop fixtures tsgit cannot exercise on CI (no PuTTY), and
   serves a small user segment relative to the item's core value.

## Decision

**Option 1, ratified by the user.** tsgit builds argv for OpenSSH-style clients only.
`GIT_SSH_COMMAND` / `GIT_SSH` / `core.sshCommand` are still honoured in git's
resolution order — a user whose command *is* plink simply gets OpenSSH-shaped flags,
exactly as git treats `ssh.variant=ssh` when forced. Variant auto-detection
(basename sniffing + `ssh.variant`) is a **documented faithfulness deferral** tracked
as a follow-up backlog entry in Phase 25.

## Consequences

### Positive
- The item ships the universal default (macOS/Linux/modern-Windows OpenSSH) without a
  Windows-PuTTY-only test matrix.
- The deferral is scoped and mechanical to add later: one variant table feeding the
  same pure argv builder (ADR-435).

### Negative
- A PuTTY/plink user gets `-p` instead of `-P` until the follow-up lands — a real,
  documented divergence from canonical git behaviour.

### Neutral
- No wire or on-disk divergence — the deferral affects only which local argv is
  spawned for non-OpenSSH clients.
