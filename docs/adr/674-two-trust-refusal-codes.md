# 674 — Two trust refusal codes, and the implicit-gitdir code keeps git's name

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/ownership-trust-gate.md (candidate D6) · **Refines:** ADR-249, ADR-654

## Context

Two independent refusals exist, with their own measured ordering (the bare-repository one fires
first, and `safe.directory` does not lift it): dubious ownership, and the
`safe.bareRepository = explicit` refusal of ADR-675.

The second condition's *name* is a genuine fork, because measurement and git's message text
disagree. git says `cannot use bare repository '<dir>'`, but the predicate is measurably **not
about bareness**: two byte-identical copies of one gitdir land on opposite verdicts based only
on whether the directory is named `.git`, and flipping `core.bare` changes nothing. The real
predicate is *discovery reached the gitdir by the cwd-is-a-gitdir route AND its basename is not
literally `.git`*.

## Options considered

1. **Two codes** — `DUBIOUS_OWNERSHIP { path }` and `IMPLICIT_BARE_REPOSITORY { gitDir }`
   (design recommendation) — pros: follows ADR-654; two measured conditions with their own
   ordering / cons: the second name asserts something the measurement disproves.
2. **One code** — `REPOSITORY_UNTRUSTED { path, reason }` — pros: one member / cons: erases a
   distinction that has its own measured ordering, and a `reason` string survives the
   `StringLiteral` mutants distinct codes kill.
3. **Reuse `NOT_A_REPOSITORY`** — pros: no new code / cons: measurably wrong — git emits a
   *different* fatal for "no repository", and it tells a caller "this is not a repository" about
   one that is perfectly valid and merely foreign.

## Decision

**Option 1 — two codes; the second named `IMPLICIT_BARE_REPOSITORY`, ratified by the user.**

The name follows git's message rather than the measured predicate, keeping the tie between the
tsgit code and the `fatal:` line a user will search for. The alternative (`IMPLICIT_GIT_DIR`)
would describe the predicate accurately but break that tie.

Because the name is known to be imprecise, the predicate is stated exactly in the code's JSDoc,
in `docs/use/errors.md`, and in the design — so nothing downstream infers bareness from it.

## Consequences

- The gap between the code name and its predicate is a documented, deliberate choice; a future
  reader who finds the mismatch will find this ADR rather than a bug.
- Two members and factories in `src/domain/repository/error.ts`, two `extractDetail` arms, two
  rows in `docs/use/errors.md`, and a regenerated `reports/api.json`.
- Payloads carry fields only (ADR-249); the interop suite reconstructs git's exact bytes,
  including that the ownership refusal is four lines with an unquoted path on the hint line and
  the bare-repository refusal is one line with no hint block.
