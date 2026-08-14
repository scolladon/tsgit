# 632 — Symlink targets are written verbatim, like git

- **Status:** accepted (ratified by user, against the design recommendation)
- **Date:** 2026-08-13
- **Design:** docs/design/git-parity-containment.md (DC-10) · **Supersedes/Refines:** supersedes [ADR-051](051-symlink-target-containment.md)

## Context

ADR-051 refuses to create a symlink whose **absolute** target resolves outside the
repository roots (relative targets were always exempt, so the gate was partial). Pinned
(git 2.55.0): git writes such links verbatim — cloning a repo containing
`link -> /etc/passwd` writes the symlink, target untouched, no refusal. Keeping the gate
means tsgit cannot clone such a repo: a documented stricter-than-git divergence. The
design recommended keeping it as the primary creation-time defence once reads are
unguarded.

## Options considered

1. Keep the refusal (design recommendation) — stricter than git; hostile absolute-target
   links cannot be created; clone of repos containing them keeps failing.
2. **Relax to git parity — write the link verbatim** — clone works like git; the
   caller-side no-dereference discipline (R5) becomes the line against blind reads
   following a planted link.
3. Relax it and add a read-time leaf check instead — DC-1's rejected lstat-per-read by
   another name.

## Decision

**Ratified by the user: option 2**, overriding the recommendation. The library follows
git: a symlink's target — absolute or relative — is opaque bytes, written verbatim,
never validated against the root set. ADR-051 is superseded; its
`realpathNearestExisting`-based target gate is removed. The defence against dereferencing
a hostile link is where git keeps it: working-tree content readers never `fs.read` a
path they have not established is a non-symlink (the R5 audit of all six read sites,
contract-pinned per ADR-629), and `openWithNoFollow` guards the surfaces that declare
no-follow.

## Consequences

- tsgit can clone any repository git can clone — the last symlink-shaped clone
  divergence goes.
- The R5 caller-side audit is now fully load-bearing (no adapter backstop behind it);
  its six sites each carry an isolated test, and new content-read call sites must follow
  the same discipline.
- ADR-051 is marked superseded; its tests are retired with the gate.
- Threat-model residual (recorded, accepted): a hostile repo can plant a symlink to any
  absolute path; reading it as *content* yields the target path string (as git does),
  and only a caller violating R5 could dereference it.
