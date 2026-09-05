---
subjects:
  - test/unit/ports/file-system.contract.ts
---
# 812 — Cross-adapter exclusive-create refusals are proven in the port contract suite

- **Status:** accepted
- **Date:** 2026-09-05
- **Design:** docs/design/memory-write-exclusive-directory.md (DC-C) · **Supersedes/Refines:** none

## Context

The brief asked whether `test/parity/**` has a slot for exclusive-create refusals. It does:
scenarios call `repo.ctx.fs.*` routinely. But every registered scenario also runs against real
OPFS in `test/browser/parity.spec.ts`, so a refusal scenario is a browser assertion too and turns
that spec red on the browser adapter's own gap. `test/unit/ports/file-system.contract.ts` is the
purpose-built cross-adapter home: one exported `fileSystemContractTests` driven by both the memory
and the node unit suites, already carrying a file-occupant `writeExclusive` row, with assertion
helpers that check the code and never the path. It also carries a tolerant precedent that accepts
either of two codes for `mkdir` on a file.

## Options considered

1. **Contract suite only: a strict `FILE_EXISTS` directory-occupant row plus a strict
   depth-two ancestor row asserting `NOT_A_DIRECTORY` by code, with a note that depth one is
   adapter-dependent** (designer's recommendation) — pros: idiomatic in that file, both adapters
   already driven, no latitude where none is justified.
2. **Those rows plus a `test/parity/` scenario projecting the refusal code into the golden** —
   cons: duplicates the contract row with a weaker oracle, couples to the browser fix, and needs
   path normalisation across a `/repo` root and an `mkdtemp` root.
3. **Memory-only unit rows** — cons: leaves the node side unwritten and the parity claim unproven.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** The two rows live next to the existing
`writeExclusive` rows in the contract suite, one strict code each. The directory row is strict
because both adapters are pinned to `FILE_EXISTS`; the ancestor row is strict on the code at
depth two, where both adapters agree. No parity scenario is added. Both adapters give `FILE_EXISTS`
for a symlink occupant today, but no symlink row is added: the file gates symlink behaviour per
adapter through a capability hook, and a row that happens to agree without such a declaration
would over-constrain a future adapter.

## Consequences

A future adapter that admits a directory occupant, or emits the wrong one of the two codes for
it, fails the contract suite before any command-level test sees it. The parity slot stays
available for a later scenario once the browser adapter is fixed, should one be wanted.
