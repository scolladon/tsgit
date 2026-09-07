---
subjects:
  - test/unit/ports/file-system.contract.ts
supersedes:
  - adr: "819"
    scope: "the tolerant write and rename refusal rows in the shared contract suite"
---
# 824 — Write and rename refusal rows in the shared contract suite assert exact codes

- **Status:** accepted
- **Date:** 2026-09-06
- **Design:** docs/design/memory-write-exclusive-directory.md (DC-P) · **Supersedes/Refines:** supersedes ADR-819 (tolerant contract rows only); refines ADR-812

## Context

ADR-819 made the `write` and `rename` refusal rows of the shared contract suite tolerant — error
instance plus non-destructiveness, no code — because every one of them was unverified on Windows,
where the unit project runs. The Windows column has since been measured through the composed node
adapter: the rows that refuse today agree on all three operating systems before any change, and the
node adapter now enforces the POSIX kind rules on Windows for the rows that did not. The user's
settled decision only required the two red positive rows to pass unchanged; tightening the tolerant
rows goes beyond it, so the choice was put to the user.

## Options considered

1. **Keep every row tolerant** — ADR-819 exactly as written — pros: the literal reading of the
   settled constraint / cons: exact codes stay asserted only in the platform-bound files.
2. **Strict codes on the three `rename` refusal rows, `write` stays tolerant** — pros: covers the
   rows the emulation changes / cons: leaves one measured row tolerant for no stated reason.
3. **Strict codes on every `write` and `rename` refusal row; the tolerant helper is deleted**
   (designer's recommendation) — pros: the cross-adapter proof is one file again, and a Windows
   regression in the emulation turns a shared row red / cons: the same regression no longer stays
   confined to the Windows-only job.

## Decision

**Ratified by the user: option 3, as recommended.** Every `write` and `rename` refusal row in the
shared contract suite asserts the exact code: a non-exclusive write onto a directory and a
non-directory renamed onto a directory refuse with `PERMISSION_DENIED`; a directory renamed onto a
regular file refuses with `NOT_A_DIRECTORY`; a directory renamed onto a non-empty directory refuses
with `DIRECTORY_NOT_EMPTY`. The instance-only refusal helper has no callers afterwards and is
removed.

Superseded from ADR-819: the clause that the `write` and `rename` refusal rows assert the error
instance and non-destructiveness only.

Carried forward from ADR-819: the posix-only integration file as the home of the node adapter's
exact codes for the rows the contract suite does not carry — the symlink rows, the inside-source
reason string, and the root row's enumerated pair — and the strict exclusive-create rows of
ADR-812.

## Consequences

The contract suite is the single cross-adapter proof for these four refusals again. A Windows
regression in the node adapter's emulation is caught by the unit matrix on every push, not only by
the Windows-only integration job. The memory adapter already produces every code the rows assert.
