# 681 — SHA-256 reaches full write parity

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/sha256-object-format.md (candidate D2) · **Refines:** ADR-667

## Context

ADR-667 accepts `extensions.objectFormat` at the gate and requires that acceptance not be a lie.
The measured defect is seven distinct outcomes, not one: loose repositories give
`OBJECT_HASH_MISMATCH`, packed ones give `OBJECT_NOT_FOUND` (the `.idx` size check fails at
20-byte strides, so unreadable reads as *absent*), `catFile` throws a **raw `TypeError`** that
escapes the `TsgitError` union entirely, `status` gives `INVALID_INDEX_HEADER`, and `revParse`
**succeeds**, returning a valid 64-hex oid from a repository nothing else can read.

Separately and more seriously: `openRepository({ algorithm: 'sha256' })` is a **documented,
shipped public option** that silently writes a corrupt `.git/index`. `index-writer.ts` has
`ENTRY_HEADER_SIZE = 62` and writes the 2-byte flags at `offset + 60` and the name at
`offset + 62` — on top of the 32-byte oid. `status` then reports a truncated 40-hex id with no
error. This is a live data-integrity bug on the current release, reachable without any new option.

## Options considered

1. **Read + write into an existing repository, no creation** — pros: fixes the index corruption
   / cons: asymmetry — `openRepository({ algorithm: 'sha256' })` would work while `init` could
   not produce the repository it opens.
2. **Full parity** (design recommendation) — `init({ objectFormat: 'sha256' })` creates SHA-256
   repositories, `clone` adopts the source's format, every write path width-generic.
3. **Read-only** — pros: smallest / cons: leaves the shipped corruption reachable unless the
   existing public option is refused, which would remove a documented capability.

## Decision

**Option 2 — ratified by the user.**

tsgit reads, writes, and creates SHA-256 repositories. `init` gains an object-format option,
`clone` adopts the source's format, and every width-sensitive write path is generic.

## Consequences

- The shipped `.git/index` corruption is fixed as a consequence, not as a separate hotfix.
- The audit falsified its own opening hypothesis and that stands as guidance: `.rev`, midx and
  commit-graph already handle their hash-identifier fields correctly. The defects are
  concentrated in the older width-implicit formats, which is where the sweep must focus.
- Write-path/read-path symmetry — a recurring blind spot in this repository — is now a
  first-class requirement rather than a review question, because both directions ship together.
- Bundle v3 (ADR-683) becomes required rather than optional: a format tsgit can create must not
  have a command that silently emits an unreadable artefact.
