---
subjects:
  - test/unit/ports/file-system.contract.ts
  - .github/workflows/ci.yml
---
# 819 — Node-side write and rename refusal codes are pinned in the posix-only integration suite

> **Superseded by [ADR-824](824-write-and-rename-refusal-rows-in-the-shared-contract-suite-assert-exact-codes.md)**
> for the tolerant write and rename refusal rows in the shared contract suite: every cell of the
> Windows-risk column this record rested on has since been measured on the Windows runner, and the
> node adapter now enforces the POSIX kind rules there, so those rows assert exact codes. Everything
> else here — the posix-only file as the home of the node adapter's exact codes for the rows the
> contract suite does not carry, and the strict exclusive-create rows — still stands.

- **Status:** superseded by ADR-824
- **Date:** 2026-09-05
- **Design:** docs/design/memory-write-exclusive-directory.md (DC-J) · **Supersedes/Refines:** refines ADR-812

## Context

The shared port contract suite runs in the unit project, which CI executes on `windows-latest`.
The `write` and `rename` matrices were verified on darwin and linux only; on Windows node's
`fs.rename` is `MoveFileExW`, whose replace-existing flag is documented not to replace
directories, so the positive row where a directory replaces an empty directory is the likeliest
Windows failure, and a positive row cannot be absorbed by a tolerant code list. The suite already
carries two tolerance precedents: an enumerated code pair for `mkdir` on a file, and an
instance-only assertion for `rm` on a non-empty directory. `test/integration/posix-only/` exists
and the `posix-integration` job runs it on ubuntu and macos.

## Options considered

1. **Strict codes in the contract suite; convert any row Windows rejects to the enumerated-pair
   precedent** — cons: designs a claim the evidence cannot support, and a failing positive row has
   no tolerant form.
2. **Contract rows assert a structured `TsgitError` plus non-destructiveness with no code; strict
   node-side codes live in a new file under `test/integration/posix-only/`** (designer's
   recommendation) — pros: keeps a strict node-side code somewhere that runs, without asserting a
   platform-unverified code cross-platform / cons: the cross-adapter proof spans two files.
3. **Tolerant contract rows only; strict codes memory-side alone** — cons: node's `rename` codes
   are asserted nowhere.

## Decision

**Adopted-as-recommended (no user judgment): option 2.** The `write` and `rename` refusal rows in
the contract suite assert the error instance and non-destructiveness only, following the
non-empty-directory precedent. A new posix-only integration file pins the node adapter's exact
codes for every darwin-and-linux-agreeing row of the matrices. The `writeExclusive` rows stay
strict in the contract suite per ADR-812, since `O_EXCL` is universal and the existing file-occupant
row already passes on Windows. The platform-divergent inside-source row is pinned memory-side only.

## Consequences

ADR-812's placement holds for exclusive create and is refined, not superseded, for the two new
surfaces. A Windows-specific `rename` divergence, if one exists, surfaces as a red positive row in
the contract suite, and is then a recorded decision, not a silent tolerance.
